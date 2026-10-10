import assert from "node:assert/strict";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pool } from "pg";
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
