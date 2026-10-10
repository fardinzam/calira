import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  listEnabledWorkflows,
  listWorkflows,
  getWorkflow,
  saveWorkflow,
  setWorkflowEnabled,
  updateWorkflow,
} from "../src/lib/workflows";
import { config, metadata } from "./workflow-fixtures";

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
    { name: "Consultations", formId: "form-1", config },
    db,
    metadata,
  );
  const first = new Date("2026-10-08T10:00:00.000Z");
  const second = new Date("2026-10-08T12:00:00.000Z");
  try {
    const enabled = await setWorkflowEnabled(
      saved.id,
      true,
      first,
      db,
      metadata,
    );
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

    const reenabled = await setWorkflowEnabled(
      saved.id,
      true,
      second,
      db,
      metadata,
    );
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

test("draft persists but cannot enable; complete config survives a new connection", async () => {
  const saved = await saveWorkflow(
    { name: "Draft", formId: "form-1", config: { calendarId: "primary" } },
    db,
  );
  try {
    await assert.rejects(
      setWorkflowEnabled(saved.id, true, new Date(), db, metadata),
      /question/i,
    );
    assert.equal((await getWorkflow(saved.id, db))?.enabled, false);
    const updated = await updateWorkflow(
      saved.id,
      { name: "Consultations", formId: "form-1", config },
      db,
      metadata,
    );
    assert.equal(
      (updated.config as { calendarId: string }).calendarId,
      "primary",
    );
    const reopened = new Pool({ connectionString });
    try {
      assert.equal(
        (
          (await getWorkflow(saved.id, reopened))?.config as {
            calendarId: string;
          }
        ).calendarId,
        "primary",
      );
    } finally {
      await reopened.end();
    }
    await setWorkflowEnabled(saved.id, true, new Date(), db, metadata);
    assert.equal((await getWorkflow(saved.id, db))?.enabled, true);
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("invalid complete save and mismatched Form metadata are rejected", async () => {
  await assert.rejects(
    saveWorkflow(
      {
        name: "Bad",
        formId: "form-1",
        config: { ...config, gmail: { subject: "Request", body: "" } },
      },
      db,
      metadata,
    ),
    /body/i,
  );
  await assert.rejects(
    saveWorkflow(
      { name: "Bad", formId: "different-form", config },
      db,
      metadata,
    ),
    /form metadata/i,
  );
});

test("a complete-looking configuration cannot be saved without Form metadata", async () => {
  await assert.rejects(
    saveWorkflow({ name: "Unverified", formId: "form-1", config }, db),
    /form metadata/i,
  );
  const saved = await saveWorkflow(
    { name: "Draft", formId: "form-1", config: { calendarId: "primary" } },
    db,
  );
  try {
    await assert.rejects(
      updateWorkflow(
        saved.id,
        { name: "Unverified", formId: "form-1", config },
        db,
      ),
      /form metadata/i,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("enabled Form ID cannot change; disabled Form ID can change without moving cursor", async () => {
  const saved = await saveWorkflow(
    { name: "Consultations", formId: "form-1", config },
    db,
    metadata,
  );
  const first = new Date("2026-10-08T10:00:00.000Z");
  try {
    await setWorkflowEnabled(saved.id, true, first, db, metadata);
    await assert.rejects(
      updateWorkflow(
        saved.id,
        { name: "Consultations", formId: "other-form" },
        db,
      ),
      /disable/i,
    );
    await setWorkflowEnabled(saved.id, false, new Date(), db);
    const changed = await updateWorkflow(
      saved.id,
      { name: "Consultations", formId: "other-form" },
      db,
    );
    assert.equal(changed.formId, "other-form");
    assert.equal(changed.config, null);
    assert.equal(changed.cursorAt?.toISOString(), first.toISOString());
    await assert.rejects(
      setWorkflowEnabled(saved.id, true, new Date(), db, metadata),
      /form metadata/i,
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});

test("an enabled workflow cannot be changed to an unvalidated draft", async () => {
  const saved = await saveWorkflow(
    { name: "Consultations", formId: "form-1", config },
    db,
    metadata,
  );
  try {
    await setWorkflowEnabled(saved.id, true, new Date(), db, metadata);
    await assert.rejects(
      updateWorkflow(
        saved.id,
        { name: "Consultations", formId: "form-1", config: { calendarId: "" } },
        db,
      ),
      /form metadata/i,
    );
    assert.equal(
      ((await getWorkflow(saved.id, db))?.config as { calendarId: string })
        .calendarId,
      "primary",
    );
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [saved.id]);
  }
});
