import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  listEnabledWorkflows,
  listWorkflows,
  saveWorkflow,
  setWorkflowEnabled,
} from "../src/lib/workflows";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const db = new Pool({ connectionString });
after(() => db.end());

test("saveWorkflow rejects blank names and Form IDs", async () => {
  await assert.rejects(
    saveWorkflow({ name: "  ", formId: "form-1" }, db),
    /name/i,
  );
  await assert.rejects(
    saveWorkflow({ name: "Consultations", formId: "  " }, db),
    /form id/i,
  );
});

test("a saved workflow and poll row survive a new database connection", async () => {
  const saved = await saveWorkflow(
    { name: "  Consultations  ", formId: "  form-1  " },
    db,
  );
  try {
    assert.equal(saved.name, "Consultations");
    assert.equal(saved.formId, "form-1");
    assert.equal(saved.enabled, false);

    const reopened = new Pool({ connectionString });
    try {
      const workflows = await listWorkflows(reopened);
      assert.ok(workflows.some((workflow) => workflow.id === saved.id));
      const state = await reopened.query(
        "SELECT cursor_at FROM form_poll_state WHERE workflow_id = $1",
        [saved.id],
      );
      assert.equal(state.rowCount, 1);
      assert.equal(state.rows[0].cursor_at, null);
    } finally {
      await reopened.end();
    }
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("enable and re-enable reset the baseline; disable removes polling eligibility", async () => {
  const saved = await saveWorkflow(
    { name: "Consultations", formId: "form-2" },
    db,
  );
  const first = new Date("2026-10-08T10:00:00.000Z");
  const second = new Date("2026-10-08T12:00:00.000Z");
  try {
    const enabled = await setWorkflowEnabled(saved.id, true, first, db);
    assert.equal(enabled.enabledAt?.toISOString(), first.toISOString());
    assert.ok(
      (await listEnabledWorkflows(db)).some(
        (workflow) => workflow.id === saved.id,
      ),
    );
    let state = await db.query(
      "SELECT cursor_at FROM form_poll_state WHERE workflow_id = $1",
      [saved.id],
    );
    assert.equal(state.rows[0].cursor_at.toISOString(), first.toISOString());

    await setWorkflowEnabled(saved.id, false, second, db);
    assert.ok(
      !(await listEnabledWorkflows(db)).some(
        (workflow) => workflow.id === saved.id,
      ),
    );

    const reenabled = await setWorkflowEnabled(saved.id, true, second, db);
    assert.equal(reenabled.enabledAt?.toISOString(), second.toISOString());
    state = await db.query(
      "SELECT cursor_at FROM form_poll_state WHERE workflow_id = $1",
      [saved.id],
    );
    assert.equal(state.rows[0].cursor_at.toISOString(), second.toISOString());
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});
