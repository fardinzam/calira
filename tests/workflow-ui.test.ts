import assert from "node:assert/strict";
import { after, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pool } from "pg";
import { insertRunIfAbsent } from "../src/lib/runs";
import { saveWorkflow } from "../src/lib/workflows";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
process.env.DATABASE_URL = connectionString;
const db = new Pool({ connectionString });
after(() => db.end());

const actions = import("../src/app/workflows/actions");
const homePage = import("../src/app/page");
const newWorkflowPage = import("../src/app/workflows/new/page");
const runsPage = import("../src/app/runs/page");
const runList = import("../src/app/runs/run-list");

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
