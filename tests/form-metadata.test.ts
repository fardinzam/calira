import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { google, forms_v1 } from "googleapis";
import { getFormQuestions } from "../src/lib/google/form-metadata";
import { validateWorkflowConfig } from "../src/lib/workflow-config";

async function withFormApi(
  get: (request: { formId: string }) => Promise<{ data: forms_v1.Schema$Form }>,
  run: () => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "automator-metadata-"));
  const tokenFile = join(directory, "token.json");
  await writeFile(tokenFile, JSON.stringify({ refresh_token: "test-token" }), {
    mode: 0o600,
  });
  const savedEnv = { ...process.env };
  const originalForms = google.forms;
  try {
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_TOKEN_FILE = tokenFile;
    google.forms = (() => ({
      forms: { get },
    })) as unknown as typeof google.forms;
    await run();
  } finally {
    google.forms = originalForms;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

test("maps six native reference questions to the shared validation contract", async () => {
  const requests: string[] = [];
  await withFormApi(
    async ({ formId }) => {
      requests.push(formId);
      return {
        data: {
          formId,
          items: [
            {
              title: "Your name",
              questionItem: {
                question: {
                  questionId: "name",
                  required: true,
                  textQuestion: {},
                },
              },
            },
            {
              title: "Email",
              questionItem: {
                question: {
                  questionId: "email",
                  required: true,
                  textQuestion: { paragraph: false },
                },
              },
            },
            {
              title: "Request type",
              questionItem: {
                question: {
                  questionId: "type",
                  required: true,
                  choiceQuestion: {
                    type: "RADIO",
                    options: [{ value: "Consultation" }, { value: "Other" }],
                  },
                },
              },
            },
            {
              title: "Requested date",
              questionItem: {
                question: {
                  questionId: "date",
                  required: true,
                  dateQuestion: { includeYear: true, includeTime: false },
                },
              },
            },
            {
              title: "Requested time",
              questionItem: {
                question: {
                  questionId: "time",
                  required: true,
                  timeQuestion: { duration: false },
                },
              },
            },
            {
              title: "Notes",
              questionItem: {
                question: {
                  questionId: "notes",
                  required: false,
                  textQuestion: { paragraph: true },
                },
              },
            },
          ],
        },
      };
    },
    async () => {
      const metadata = await getFormQuestions("form-123");
      assert.deepEqual(requests, ["form-123"]);
      assert.deepEqual(metadata, {
        formId: "form-123",
        questions: [
          { id: "name", title: "Your name", type: "shortText", required: true },
          { id: "email", title: "Email", type: "shortText", required: true },
          {
            id: "type",
            title: "Request type",
            type: "multipleChoice",
            required: true,
            options: ["Consultation", "Other"],
          },
          {
            id: "date",
            title: "Requested date",
            type: "date",
            required: true,
            hasYear: true,
            includeTime: false,
          },
          {
            id: "time",
            title: "Requested time",
            type: "time",
            required: true,
            duration: false,
          },
          { id: "notes", title: "Notes", type: "paragraph", required: false },
        ],
      });
      assert.deepEqual(
        validateWorkflowConfig(
          {
            calendarId: "primary",
            timeZone: "America/Los_Angeles",
            questions: {
              name: "name",
              email: "email",
              requestType: "type",
              requestedDate: "date",
              requestedTime: "time",
              notes: "notes",
            },
            filter: { equals: "Consultation" },
            gmail: {
              subject: "Consultation for {{name}}",
              body: "Request: {{notes}}",
            },
          },
          metadata,
        ).questions.requestType,
        "type",
      );
    },
  );
});

test("keeps incompatible date, duration, and choice modes visible without coercion", async () => {
  await withFormApi(
    async () => ({
      data: {
        items: [
          {
            title: "Date without year",
            questionItem: {
              question: {
                questionId: "date",
                dateQuestion: { includeYear: false, includeTime: true },
              },
            },
          },
          {
            title: "Duration",
            questionItem: {
              question: {
                questionId: "duration",
                timeQuestion: { duration: true },
              },
            },
          },
          {
            title: "Checkbox",
            questionItem: {
              question: {
                questionId: "checkbox",
                choiceQuestion: {
                  type: "CHECKBOX",
                  options: [{ value: "Consultation" }],
                },
              },
            },
          },
          {
            title: "Dropdown",
            questionItem: {
              question: {
                questionId: "dropdown",
                choiceQuestion: {
                  type: "DROP_DOWN",
                  options: [{ value: "Consultation" }],
                },
              },
            },
          },
          {
            title: "Unknown choice",
            questionItem: {
              question: {
                questionId: "unknown",
                choiceQuestion: { type: "FUTURE_TYPE" },
              },
            },
          },
          {
            title: "File",
            questionItem: {
              question: { questionId: "file", fileUploadQuestion: {} },
            },
          },
        ],
      },
    }),
    async () => {
      assert.deepEqual((await getFormQuestions("form-123")).questions, [
        {
          id: "date",
          title: "Date without year",
          type: "date",
          required: false,
          hasYear: false,
          includeTime: true,
        },
        {
          id: "duration",
          title: "Duration",
          type: "time",
          required: false,
          duration: true,
        },
        {
          id: "checkbox",
          title: "Checkbox",
          type: "unsupported",
          required: false,
        },
        {
          id: "dropdown",
          title: "Dropdown",
          type: "unsupported",
          required: false,
        },
        {
          id: "unknown",
          title: "Unknown choice",
          type: "unsupported",
          required: false,
        },
        { id: "file", title: "File", type: "unsupported", required: false },
      ]);
    },
  );
});

test("skips non-question items and missing question IDs", async () => {
  await withFormApi(
    async () => ({
      data: {
        items: [
          { title: "Section", textItem: {} },
          { title: "Broken", questionItem: { question: { textQuestion: {} } } },
          {
            title: "Untitled",
            questionItem: {
              question: { questionId: "valid", textQuestion: {} },
            },
          },
          {
            title: "Ratings",
            questionGroupItem: {
              questions: [
                {
                  questionId: "row",
                  rowQuestion: { title: "First row" },
                  required: true,
                },
              ],
            },
          },
        ],
      },
    }),
    async () => {
      assert.deepEqual((await getFormQuestions("form-123")).questions, [
        { id: "valid", title: "Untitled", type: "shortText", required: false },
        {
          id: "row",
          title: "Ratings — First row",
          type: "unsupported",
          required: true,
        },
      ]);
    },
  );
});

test("rejects missing Form IDs without an API call", async () => {
  await withFormApi(
    async () => {
      throw new Error("unexpected API call");
    },
    async () => {
      await assert.rejects(getFormQuestions(" "), /Form ID is required/);
    },
  );
});

test("preserves the local token reconnect instruction", async () => {
  const savedEnv = { ...process.env };
  try {
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_TOKEN_FILE = "/path/that/does/not/exist";
    await assert.rejects(
      getFormQuestions("form-123"),
      /GOOGLE_TOKEN_FILE is missing or invalid; run the local authorization script/,
    );
  } finally {
    process.env = savedEnv;
  }
});

test("access and revoked-authorization errors never expose Google details", async () => {
  for (const failure of [
    { response: { status: 403 }, message: "secret-access-value" },
    { response: { status: 401 }, message: "secret-token-value" },
    {
      response: {
        status: 400,
        data: {
          error: "invalid_grant",
          error_description: "secret-refresh-value",
        },
      },
    },
    { response: { status: 404 }, message: "secret-form-value" },
  ]) {
    await withFormApi(
      async () => {
        throw failure;
      },
      async () => {
        await assert.rejects(getFormQuestions("form-123"), (error: Error) => {
          assert.doesNotMatch(error.message, /secret-|invalid_grant/);
          assert.match(error.message, /Form|Google|reconnect/);
          return true;
        });
      },
    );
  }
});
