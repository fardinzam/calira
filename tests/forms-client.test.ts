import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { google } from "googleapis";
import { getGoogleAuth } from "../src/lib/google/auth";
import { listFormResponses } from "../src/lib/google/forms";

test("uses inclusive UTC timestamp and page token without changing the filter", async () => {
  const requests: unknown[] = [];
  const list = async (request: {
    formId: string;
    filter: string;
    pageToken?: string;
  }) => {
    requests.push(request);
    return { data: { responses: [], nextPageToken: "next-page" } };
  };
  const since = new Date("2026-10-08T10:20:30.123Z");
  assert.deepEqual(await listFormResponses("form-1", since, undefined, list), {
    responses: [],
    nextPageToken: "next-page",
  });
  await listFormResponses("form-1", since, "next-page", list);
  assert.deepEqual(requests, [
    { formId: "form-1", filter: "timestamp >= 2026-10-08T10:20:30.123Z" },
    {
      formId: "form-1",
      filter: "timestamp >= 2026-10-08T10:20:30.123Z",
      pageToken: "next-page",
    },
  ]);
});

test("preserves response timestamps and all answer values", async () => {
  const answers = {
    name: { questionId: "name", textAnswers: { answers: [{ value: "Ava" }] } },
    services: {
      questionId: "services",
      textAnswers: {
        answers: [{ value: "Consultation" }, { value: "Planning" }],
      },
    },
  };
  const result = await listFormResponses(
    "form-1",
    new Date(0),
    undefined,
    async () => ({
      data: {
        responses: [
          {
            responseId: "r-1",
            createTime: "2026-10-08T10:00:00Z",
            lastSubmittedTime: "2026-10-08T11:00:00Z",
            answers,
          },
          {
            responseId: "r-2",
            createTime: "2026-10-08T12:00:00Z",
            lastSubmittedTime: "2026-10-08T12:00:00Z",
          },
        ],
      },
    }),
  );
  assert.deepEqual(result, {
    responses: [
      {
        responseId: "r-1",
        createTime: "2026-10-08T10:00:00Z",
        lastSubmittedTime: "2026-10-08T11:00:00Z",
        answers,
      },
      {
        responseId: "r-2",
        createTime: "2026-10-08T12:00:00Z",
        lastSubmittedTime: "2026-10-08T12:00:00Z",
        answers: {},
      },
    ],
  });
});

test("rejects incomplete or invalid Google responses", async () => {
  for (const response of [
    {
      createTime: "2026-10-08T10:00:00Z",
      lastSubmittedTime: "2026-10-08T10:00:00Z",
    },
    { responseId: "r-1", lastSubmittedTime: "2026-10-08T10:00:00Z" },
    { responseId: "r-1", createTime: "2026-10-08T10:00:00Z" },
    {
      responseId: "r-1",
      createTime: "bad",
      lastSubmittedTime: "2026-10-08T10:00:00Z",
    },
  ]) {
    await assert.rejects(
      listFormResponses("form-1", new Date(0), undefined, async () => ({
        data: { responses: [response] },
      })),
      /missing or invalid required fields/,
    );
  }
});

test("missing or malformed credentials fail without exposing values", async () => {
  const saved = { ...process.env };
  try {
    process.env.GOOGLE_CLIENT_ID = "private-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "private-client-secret";
    delete process.env.GOOGLE_TOKEN_FILE;
    await assert.rejects(getGoogleAuth(), (error: Error) => {
      assert.equal(error.message, "Missing GOOGLE_TOKEN_FILE");
      assert.doesNotMatch(error.message, /private-client/);
      return true;
    });
    process.env.GOOGLE_TOKEN_FILE = "/path/that/does/not/exist";
    await assert.rejects(
      getGoogleAuth(),
      /GOOGLE_TOKEN_FILE is missing or invalid/,
    );
  } finally {
    process.env = saved;
  }
});

test("Google request failures keep the status but not credential-bearing details", async () => {
  await assert.rejects(
    listFormResponses("form-1", new Date(0), undefined, async () => {
      throw { response: { status: 403 }, message: "private-token-value" };
    }),
    (error: Error) => {
      assert.equal(error.message, "Google Forms request failed (HTTP 403)");
      return true;
    },
  );
});

test("revoked Google credentials require reconnect without exposing response details", async () => {
  await assert.rejects(
    listFormResponses("form-1", new Date(0), undefined, async () => {
      throw {
        response: {
          status: 400,
          data: {
            error: "invalid_grant",
            error_description: "private-refresh-token-value",
          },
        },
      };
    }),
    (error: Error) => {
      assert.equal(
        error.message,
        "Google authorization expired or revoked; reconnect the owner account",
      );
      assert.doesNotMatch(
        error.message,
        /private-refresh-token-value|invalid_grant/,
      );
      return true;
    },
  );
  await assert.rejects(
    listFormResponses("form-1", new Date(0), undefined, async () => {
      throw {
        response: { status: 401 },
        message: "private-access-token-value",
      };
    }),
    (error: Error) => {
      assert.equal(
        error.message,
        "Google authorization expired or revoked; reconnect the owner account",
      );
      assert.doesNotMatch(error.message, /private-access-token-value/);
      return true;
    },
  );
});

test("default Google client calls responses.list with its method receiver", async () => {
  const directory = await mkdtemp(join(tmpdir(), "automator-forms-"));
  const tokenFile = join(directory, "token.json");
  await writeFile(tokenFile, JSON.stringify({ refresh_token: "fixture-refresh-token" }), { mode: 0o600 });
  const savedEnv = { ...process.env };
  const originalForms = google.forms;
  try {
    process.env.GOOGLE_CLIENT_ID = "fixture-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fixture-client-secret";
    process.env.GOOGLE_TOKEN_FILE = tokenFile;
    google.forms = (() => ({
      forms: {
        responses: {
          marker: "receiver-present",
          async list(this: { marker: string }) {
            assert.equal(this.marker, "receiver-present");
            return { data: { responses: [] } };
          },
        },
      },
    })) as unknown as typeof google.forms;
    assert.deepEqual(await listFormResponses("form-1", new Date(0)), { responses: [] });
  } finally {
    google.forms = originalForms;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
