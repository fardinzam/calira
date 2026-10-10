import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { google } from "googleapis";
import { gmailClient } from "../src/lib/google/gmail";
import type { GmailMessageInput } from "../src/lib/run-execution";

const message: GmailMessageInput = {
  from: "owner@example.com",
  to: "requester@example.net",
  subject: "Consultation request received",
  body: "Your request for café planning was received.\nWe will reply soon.",
};

type SendRequest = { userId: string; requestBody: { raw: string } };
type SendOptions = { retry?: boolean };

async function withGmailApi(
  send: (
    request: SendRequest,
    options: SendOptions,
  ) => Promise<{ data: { id?: string | null } }>,
  run: () => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "automator-gmail-"));
  const tokenFile = join(directory, "token.json");
  await writeFile(tokenFile, JSON.stringify({ refresh_token: "test-token" }), {
    mode: 0o600,
  });
  const savedEnv = { ...process.env };
  const originalGmail = google.gmail;
  try {
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_TOKEN_FILE = tokenFile;
    google.gmail = ((options: { version: string; auth: unknown }) => {
      assert.equal(options.version, "v1");
      assert.ok(options.auth);
      return { users: { messages: { send } } };
    }) as unknown as typeof google.gmail;
    await run();
  } finally {
    google.gmail = originalGmail;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

function decodeBody(mime: string): string {
  const [headers, encodedBody] = mime.split("\r\n\r\n", 2);
  const encoding = headers.match(/^Content-Transfer-Encoding: (.+)$/im)?.[1];
  if (encoding?.toLowerCase() === "base64") {
    return Buffer.from(encodedBody.replace(/\s/g, ""), "base64").toString(
      "utf8",
    );
  }
  if (encoding?.toLowerCase() === "quoted-printable") {
    const bytes = encodedBody
      .replace(/=\r\n/g, "")
      .replace(/=([A-F0-9]{2})/gi, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    return Buffer.from(bytes, "binary").toString("utf8");
  }
  return encodedBody;
}

test("sends one UTF-8 plain-text message with only the requested headers and returns its ID", async () => {
  const requests: SendRequest[] = [];
  let sendOptions: SendOptions | undefined;
  await withGmailApi(
    async (request, options) => {
      requests.push(request);
      sendOptions = options;
      return { data: { id: "gmail-message-1" } };
    },
    async () => {
      assert.deepEqual(await gmailClient.sendMessage(message), {
        ok: true,
        value: { messageId: "gmail-message-1" },
      });
    },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(sendOptions, { retry: false });
  assert.equal(requests[0].userId, "me");
  const raw = requests[0].requestBody.raw;
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const headers = mime.split("\r\n\r\n", 1)[0];
  assert.match(headers, /^From: owner@example\.com$/im);
  assert.match(headers, /^To: requester@example\.net$/im);
  assert.match(headers, /^Subject: Consultation request received$/im);
  assert.match(headers, /^Content-Type: text\/plain; charset=utf-8$/im);
  assert.doesNotMatch(
    mime,
    /Content-Type: text\/html|Content-Disposition: attachment|Content-Type: multipart/i,
  );
  assert.doesNotMatch(headers, /^(Cc|Bcc|Reply-To):/im);
  assert.equal(decodeBody(mime).trimEnd(), message.body);
});

test("classifies confirmed HTTP 400, 401, 403, and 404 rejections without leaking responses", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    await withGmailApi(
      async () => {
        calls++;
        throw { response: { status, data: { error: "private-response" } } };
      },
      async () => {
        const result = await gmailClient.sendMessage(message);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.certainty, "rejected");
          assert.ok(result.code);
          assert.match(result.message, new RegExp(`HTTP ${status}`));
          assert.doesNotMatch(result.message, /private-response/);
        }
      },
    );
    assert.equal(calls, 1);
  }
});

test("classifies transport failures and HTTP 5xx as unknown without retrying", async () => {
  for (const failure of [
    new Error("private-transport-detail"),
    { response: { status: 500, data: "private-response" } },
    { response: { status: 503, data: "private-response" } },
  ]) {
    let calls = 0;
    await withGmailApi(
      async () => {
        calls++;
        throw failure;
      },
      async () => {
        const result = await gmailClient.sendMessage(message);
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(result.certainty, "unknown");
          assert.ok(result.code);
          assert.doesNotMatch(result.message, /private-/);
        }
      },
    );
    assert.equal(calls, 1);
  }
});

test("treats a success response without a message ID as unknown", async () => {
  await withGmailApi(
    async () => ({ data: {} }),
    async () => {
      const result = await gmailClient.sendMessage(message);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.certainty, "unknown");
        assert.ok(result.code);
      }
    },
  );
});

test("rejects header injection and non-single email addresses before an API call", async () => {
  let calls = 0;
  await withGmailApi(
    async () => {
      calls++;
      return { data: { id: "unexpected" } };
    },
    async () => {
      for (const input of [
        { ...message, from: "owner@example.com\r\nBcc: another@example.com" },
        { ...message, to: "requester@example.net\nCc: another@example.com" },
        { ...message, subject: "Request\r\nBcc: another@example.com" },
        { ...message, to: "requester@example.net, another@example.com" },
        { ...message, to: "Name <requester@example.net>" },
        { ...message, to: "invalid" },
      ]) {
        await assert.rejects(gmailClient.sendMessage(input), (error: Error) => {
          assert.match(error.message, /^Invalid Gmail /);
          assert.doesNotMatch(error.message, /requester|another|Bcc/);
          return true;
        });
      }
    },
  );
  assert.equal(calls, 0);
});
