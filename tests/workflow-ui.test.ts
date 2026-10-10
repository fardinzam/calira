import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pool } from "pg";
import { google, forms_v1 } from "googleapis";
import { insertRunIfAbsent } from "../src/lib/runs";
import { saveWorkflow } from "../src/lib/workflows";
import { config, metadataFor, questions } from "./workflow-fixtures";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
process.env.DATABASE_URL = connectionString;
const db = new Pool({ connectionString });
after(() => db.end());

const actions = import("../src/app/workflows/actions");
const homePage = import("../src/app/page");
const newWorkflowPage = import("../src/app/workflows/new/page");
const editWorkflowPage = import("../src/app/workflows/[id]/page");
const runsPage = import("../src/app/runs/page");
const runList = import("../src/app/runs/run-list");
const builderSave = import("../src/app/workflows/builder-save");
const builderPreview = import("../src/app/workflows/workflow-preview");

async function withFormApi(
  formId: string,
  requestTypeOptions: string[],
  run: () => Promise<void>,
  onRead?: () => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "automator-ui-"));
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
      forms: {
        get: async ({ formId: requestedId }: { formId: string }) => {
          onRead?.();
          assert.equal(requestedId, formId);
          return {
            data: {
              formId,
              items: [
                {
                  title: "Name",
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
                      textQuestion: {},
                    },
                  },
                },
                {
                  title: "Request type",
                  questionItem: {
                    question: {
                      questionId: "request",
                      required: true,
                      choiceQuestion: {
                        type: "RADIO",
                        options: requestTypeOptions.map((value) => ({ value })),
                      },
                    },
                  },
                },
                {
                  title: "Date",
                  questionItem: {
                    question: {
                      questionId: "date",
                      required: true,
                      dateQuestion: { includeYear: true, includeTime: false },
                    },
                  },
                },
                {
                  title: "Time",
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
            } satisfies forms_v1.Schema$Form,
          };
        },
      },
    })) as unknown as typeof google.forms;
    await run();
  } finally {
    google.forms = originalForms;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

function toggleData(id: string, enabled: boolean) {
  const data = new FormData();
  data.set("id", id);
  data.set("enabled", String(enabled));
  return data;
}

test("setup rejects blank values and shows a safe save error", async () => {
  const { createWorkflow } = await actions;
  const { default: NewWorkflow } = await newWorkflowPage;
  const marker = `ui-${crypto.randomUUID()}`;
  const form = new FormData();
  form.set("name", "  ");
  form.set("formId", marker);
  await assert.rejects(
    createWorkflow(form),
    (error: unknown) =>
      error instanceof Error &&
      "digest" in error &&
      String(error.digest).includes("/workflows/new?error=name"),
  );
  form.set("name", "Consultations");
  form.set("formId", "  ");
  await assert.rejects(
    createWorkflow(form),
    (error: unknown) =>
      error instanceof Error &&
      "digest" in error &&
      String(error.digest).includes("/workflows/new?error=formId"),
  );
  const saved = await db.query("SELECT id FROM workflow WHERE form_id = $1", [
    marker,
  ]);
  assert.equal(saved.rowCount, 0);

  const html = renderToStaticMarkup(
    await NewWorkflow({ searchParams: Promise.resolve({ error: "name" }) }),
  );
  assert.match(html, /Workflow name is required/);
  const saveErrorHtml = renderToStaticMarkup(
    await NewWorkflow({ searchParams: Promise.resolve({ error: "save" }) }),
  );
  assert.match(saveErrorHtml, /Could not save the workflow/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="formId"/);
  assert.doesNotMatch(
    html,
    /GOOGLE_CLIENT_SECRET|refresh_token|GOOGLE_TOKEN_FILE/,
  );
});

test("setup saves an incomplete workflow and home rejects enablement", async () => {
  const { createWorkflow, toggleWorkflow } = await actions;
  const { default: Home } = await homePage;
  const marker = `ui-${crypto.randomUUID()}`;
  const form = new FormData();
  form.set("name", "  Consultations  ");
  form.set("formId", marker);
  await assert.rejects(createWorkflow(form), /NEXT_REDIRECT/);
  const workflow = (
    await db.query(
      "SELECT id, name, form_id, enabled FROM workflow WHERE form_id = $1",
      [marker],
    )
  ).rows[0];
  assert.equal(workflow.name, "Consultations");
  assert.equal(workflow.enabled, false);

  try {
    let html = renderToStaticMarkup(await Home());
    assert.ok(html.includes(marker));
    assert.match(html, /Disabled/);

    const toggle = new FormData();
    toggle.set("id", workflow.id);
    toggle.set("enabled", "true");
    await assert.rejects(toggleWorkflow(toggle), /NEXT_REDIRECT/);
    assert.equal(
      (
        await db.query("SELECT enabled FROM workflow WHERE id = $1", [
          workflow.id,
        ])
      ).rows[0].enabled,
      false,
    );
    html = renderToStaticMarkup(await Home());
    assert.match(html, /Disabled/);

    toggle.set("enabled", "false");
    await assert.rejects(toggleWorkflow(toggle), /NEXT_REDIRECT/);
    assert.equal(
      (
        await db.query("SELECT enabled FROM workflow WHERE id = $1", [
          workflow.id,
        ])
      ).rows[0].enabled,
      false,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [workflow.id]);
  }
});

test("run list always shows an empty state for no runs", async () => {
  const { default: RunList } = await runList;
  assert.match(
    renderToStaticMarkup(RunList({ runs: [] })),
    /No responses detected yet/,
  );
});

test("run page shows a detected queued response without answers", async () => {
  const { default: RunsPage } = await runsPage;
  const { default: Home } = await homePage;
  const marker = `ui-${crypto.randomUUID()}`;
  const workflow = await saveWorkflow({ name: "UI runs", formId: marker }, db);
  try {
    const responseId = `response-${crypto.randomUUID()}`;
    await insertRunIfAbsent(
      workflow.id,
      {
        responseId,
        createTime: "2026-10-09T10:00:00.000Z",
        lastSubmittedTime: "2026-10-09T10:01:00.000Z",
        answers: { privateAnswer: "never-render-this-answer" },
      },
      db,
    );
    const html = renderToStaticMarkup(await RunsPage());
    const run = await db.query("SELECT id FROM run WHERE workflow_id = $1", [
      workflow.id,
    ]);
    assert.ok(html.includes(run.rows[0].id));
    assert.ok(html.includes(responseId));
    assert.ok(renderToStaticMarkup(await Home()).includes(responseId));
    assert.ok(html.includes("2026-10-09T10:01:00.000Z"));
    assert.match(html, /Queued/);
    assert.doesNotMatch(
      html,
      /never-render-this-answer|Calendar event created|Email sent/,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [workflow.id]);
  }
});

test("builder saves a complete workflow and edits it with current Form metadata", async () => {
  const { saveBuilderWorkflow } = await builderSave;
  const formId = `ui-${crypto.randomUUID()}`;
  const metadata = metadataFor(formId);
  let reads = 0;
  const readMetadata = async (requestedId: string) => {
    assert.equal(requestedId, formId);
    reads++;
    return metadata;
  };
  const created = await saveBuilderWorkflow(
    { name: "Consultations", formId, config, saveAs: "complete" },
    db,
    readMetadata,
  );
  try {
    assert.equal(created.config?.calendarId, "primary");
    assert.equal(created.config?.timeZone, "America/Los_Angeles");
    assert.equal(reads, 1);
    const updated = await saveBuilderWorkflow(
      {
        id: created.id,
        name: "Updated consultations",
        formId,
        config: {
          ...config,
          gmail: { subject: "Thank you, {{name}}", body: "Request received." },
        },
        saveAs: "complete",
      },
      db,
      readMetadata,
    );
    assert.equal(updated.name, "Updated consultations");
    assert.deepEqual(updated.config?.gmail, {
      subject: "Thank you, {{name}}",
      body: "Request received.",
    });
    assert.equal(reads, 2);
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [created.id]);
  }
});

test("builder saves an incomplete draft without asking Google for metadata", async () => {
  const { saveBuilderWorkflow } = await builderSave;
  const formId = `ui-${crypto.randomUUID()}`;
  const draft = await saveBuilderWorkflow(
    {
      name: "Draft consultation",
      formId,
      config: { ...config, questions: { ...config.questions, notes: "" } },
      saveAs: "draft",
    },
    db,
    async () => {
      throw new Error("Draft unexpectedly fetched metadata");
    },
  );
  try {
    assert.equal(draft.enabled, false);
    assert.equal((draft.config?.questions as { notes: string }).notes, "");
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [draft.id]);
  }
});

test("builder rejects incomplete and invalid complete configurations before insertion", async () => {
  const { saveBuilderWorkflow } = await builderSave;
  const formId = `ui-${crypto.randomUUID()}`;
  const readMetadata = async () => metadataFor(formId);
  await assert.rejects(
    saveBuilderWorkflow(
      {
        name: "Incomplete",
        formId,
        config: { ...config, questions: { ...config.questions, email: "" } },
        saveAs: "complete",
      },
      db,
      readMetadata,
    ),
    /complete all required fields/i,
  );
  await assert.rejects(
    saveBuilderWorkflow(
      {
        name: "Bad template",
        formId,
        config: {
          ...config,
          gmail: { subject: "Hi {{unknown}}", body: "Thanks" },
        },
        saveAs: "complete",
      },
      db,
      readMetadata,
    ),
    /unknown message placeholder/i,
  );
  const found = await db.query("SELECT id FROM workflow WHERE form_id = $1", [
    formId,
  ]);
  assert.equal(found.rowCount, 0);
});

test("builder rejects missing workflow identity before reading Form metadata", async () => {
  const { saveBuilderWorkflow } = await builderSave;
  await assert.rejects(
    saveBuilderWorkflow(
      { name: " ", formId: "form-1", config, saveAs: "complete" },
      db,
      async () => {
        throw new Error("Metadata should not be read for an invalid name");
      },
    ),
    /Workflow name is required/,
  );
});

test("builder rejects missing and unsupported Form questions", async () => {
  const { saveBuilderWorkflow } = await builderSave;
  const formId = `ui-${crypto.randomUUID()}`;
  const input = {
    name: "Consultations",
    formId,
    config,
    saveAs: "complete" as const,
  };
  await assert.rejects(
    saveBuilderWorkflow(input, db, async () => ({
      formId,
      questions: questions.filter((question) => question.id !== "date"),
    })),
    /requestedDate question does not match/i,
  );
  await assert.rejects(
    saveBuilderWorkflow(input, db, async () => ({
      formId,
      questions: questions.map((question) =>
        question.id === "email"
          ? { ...question, type: "unsupported" as const }
          : question,
      ),
    })),
    /email question does not match/i,
  );
});

test("sample preview renders each mapping without response data or Google calls", async () => {
  const { default: WorkflowPreview } = await builderPreview;
  const html = renderToStaticMarkup(WorkflowPreview({ config }));
  assert.match(html, /Example values/);
  assert.match(html, /Consultation = Consultation/);
  assert.match(html, /Calendar ID:<\/strong>\s*primary/);
  assert.match(html, /Consultation request — Alex Rivera/);
  assert.match(html, /2026-10-15 10:00 America\/Los_Angeles/);
  assert.match(html, /2026-10-15 11:00 America\/Los_Angeles/);
  assert.match(html, /alex@example.com/);
  assert.match(html, /Request from Alex Rivera/);
  assert.match(
    html,
    /We received your Consultation request for 2026-10-15 at 10:00/,
  );
  assert.doesNotMatch(html, /never-render-this-answer|refresh_token/);
});

test("edit page shows the saved mapping after a database read", async () => {
  const { default: EditWorkflow } = await editWorkflowPage;
  const formId = `ui-${crypto.randomUUID()}`;
  const saved = await saveWorkflow(
    { name: "Consultations", formId, config },
    db,
    metadataFor(formId),
  );
  try {
    const html = renderToStaticMarkup(
      await EditWorkflow({ params: Promise.resolve({ id: saved.id }) }),
    );
    assert.match(html, /Edit Consultations/);
    assert.match(html, /value="primary"/);
    assert.match(html, /Request from \{\{name\}\}/);
    assert.match(html, /America\/Los_Angeles/);
    assert.match(html, /60 minutes/);
    assert.doesNotMatch(html, /refresh_token|GOOGLE_CLIENT_SECRET/);
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("metadata and save actions return safe errors for blank setup", async () => {
  const { loadBuilderForm, saveBuilder } = await actions;
  assert.deepEqual(await loadBuilderForm(""), { error: "Form ID is required" });
  const result = await saveBuilder({
    name: " ",
    formId: "form-1",
    saveAs: "draft",
    calendarId: "",
    questions: {
      name: "",
      email: "",
      requestType: "",
      requestedDate: "",
      requestedTime: "",
      notes: "",
    },
    subject: "",
    body: "",
  });
  assert.deepEqual(result, { error: "Workflow name is required" });
});

test("home explains the consultation flow and run states", async () => {
  const { default: Home } = await homePage;
  const html = renderToStaticMarkup(
    await Home({ searchParams: Promise.resolve({ error: "configuration" }) }),
  );
  assert.match(html, /consultation request/i);
  assert.match(html, /Google Forms/);
  assert.match(html, /Filter/);
  assert.match(html, /Google Calendar/);
  assert.match(html, /Gmail/);
  assert.match(html, /eligible runs are processed by the worker/);
  assert.match(html, /href="\/workflows\/new"/);
  assert.match(html, /href="\/runs"/);
  assert.match(html, /Review the workflow configuration/);
  assert.match(
    html,
    /Older runs without a configuration snapshot remain detection history/,
  );
  assert.doesNotMatch(html, /Earlier queued runs remain detection history/);
  assert.doesNotMatch(html, /action-ready|appointment confirmed/i);
});

test("home shows an empty state in an isolated schema without touching existing workflows", async () => {
  const schema = `ui_empty_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(connectionString);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const env = { ...process.env, DATABASE_URL: isolatedUrl.toString() };
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/db-migrate.ts"],
      {
        env,
        encoding: "utf8",
      },
    );
    const html = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { renderToStaticMarkup } from "react-dom/server"; import * as page from "./src/app/page.tsx"; const Home = page.default.default; process.stdout.write(renderToStaticMarkup(await Home()));',
      ],
      { env, encoding: "utf8" },
    );
    assert.match(html, /No workflows saved yet/);
    assert.match(html, /No responses detected yet/);
    assert.match(html, /href="\/workflows\/new"/);
  } finally {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test("home shows incomplete legacy workflow and rejects enable without Google access", async () => {
  const { default: Home } = await homePage;
  const { toggleWorkflow } = await actions;
  const saved = await saveWorkflow(
    { name: "Legacy draft", formId: `ui-${crypto.randomUUID()}` },
    db,
  );
  try {
    const before = renderToStaticMarkup(await Home());
    assert.match(before, new RegExp(`href="/workflows/${saved.id}"`));
    assert.match(before, /Configuration: Incomplete/);
    assert.match(before, /Polling: Disabled/);
    await assert.rejects(
      toggleWorkflow(toggleData(saved.id, true)),
      (error: unknown) =>
        error instanceof Error &&
        "digest" in error &&
        String(error.digest).includes("/?error=incomplete"),
    );
    assert.equal(
      (await db.query("SELECT enabled FROM workflow WHERE id = $1", [saved.id]))
        .rows[0].enabled,
      false,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("home and edit page show a complete workflow enabled and disabled after reload", async () => {
  const { default: Home } = await homePage;
  const { default: EditWorkflow } = await editWorkflowPage;
  const { toggleWorkflow } = await actions;
  const formId = `ui-${crypto.randomUUID()}`;
  const saved = await saveWorkflow(
    { name: "Consultations", formId, config },
    db,
    metadataFor(formId),
  );
  try {
    let metadataReads = 0;
    await withFormApi(
      formId,
      ["Consultation", "Other"],
      async () => {
        await assert.rejects(
          toggleWorkflow(toggleData(saved.id, true)),
          /NEXT_REDIRECT/,
        );
        assert.equal(metadataReads, 1);
        assert.equal(
          (
            await db.query("SELECT enabled FROM workflow WHERE id = $1", [
              saved.id,
            ])
          ).rows[0].enabled,
          true,
        );
        const enabledHome = renderToStaticMarkup(await Home());
        assert.match(enabledHome, /Configuration: Complete/);
        assert.match(enabledHome, /Polling: Enabled/);
        assert.match(enabledHome, new RegExp(`href="/workflows/${saved.id}"`));
        const edit = renderToStaticMarkup(
          await EditWorkflow({ params: Promise.resolve({ id: saved.id }) }),
        );
        assert.match(edit, /Status: Enabled/);
        assert.match(edit, /worker processes eligible runs/);
        await assert.rejects(
          toggleWorkflow(toggleData(saved.id, false)),
          /NEXT_REDIRECT/,
        );
        assert.equal(metadataReads, 1);
      },
      () => {
        metadataReads++;
      },
    );
    assert.equal(
      (await db.query("SELECT enabled FROM workflow WHERE id = $1", [saved.id]))
        .rows[0].enabled,
      false,
    );
    assert.match(renderToStaticMarkup(await Home()), /Polling: Disabled/);
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("enable rejects a Form whose current choices no longer match the saved config", async () => {
  const { toggleWorkflow } = await actions;
  const formId = `ui-${crypto.randomUUID()}`;
  const saved = await saveWorkflow(
    { name: "Consultations", formId, config },
    db,
    metadataFor(formId),
  );
  try {
    await withFormApi(formId, ["Other"], async () => {
      await assert.rejects(
        toggleWorkflow(toggleData(saved.id, true)),
        (error: unknown) =>
          error instanceof Error &&
          "digest" in error &&
          String(error.digest).includes("/?error=configuration"),
      );
    });
    assert.equal(
      (await db.query("SELECT enabled FROM workflow WHERE id = $1", [saved.id]))
        .rows[0].enabled,
      false,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});
