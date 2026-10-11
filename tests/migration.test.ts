import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { Pool } from "pg";

const run = promisify(execFile);
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const admin = new Pool({ connectionString });
after(() => admin.end());

async function withSchema(body: (db: Pool, url: string) => Promise<void>) {
  const schema = `m02_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString!);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new Pool({ connectionString: url.toString() });
  try {
    await body(db, url.toString());
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

async function migrate(url: string) {
  await run(process.execPath, ["--import", "tsx", "scripts/db-migrate.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
  });
}

test("migrates an empty schema and reruns without replaying migrations", async () => {
  await withSchema(async (db, url) => {
    await migrate(url);
    const first = await db.query<{ version: string }>(
      "SELECT version FROM schema_migration ORDER BY version",
    );
    assert.deepEqual(
      first.rows.map((row) => row.version),
      [
        "001_init",
        "002_workflow_config",
        "003_run_execution",
        "004_recovery",
        "005_gmail_uncertainty",
      ],
    );
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'run'",
    );
    assert.ok(
      columns.rows.some((row) => row.column_name === "config_snapshot"),
    );
    for (const name of [
      "started_at",
      "finished_at",
      "error_code",
      "error_message",
    ]) {
      assert.ok(columns.rows.some((row) => row.column_name === name));
    }
    assert.equal(
      (await db.query("SELECT to_regclass('step_run')::text AS name")).rows[0]
        .name,
      "step_run",
    );
    const stepColumns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'step_run'",
    );
    for (const name of [
      "next_attempt_at",
      "retry_mode",
      "lookup_attempt_count",
      "uncertain_send_seen",
    ]) {
      assert.ok(stepColumns.rows.some((row) => row.column_name === name));
    }
    await migrate(url);
    const second = await db.query("SELECT version FROM schema_migration");
    assert.equal(second.rowCount, 5);
  });
});

test("upgrades populated Milestone 02 runs without changing snapshot, answers, or cursor", async () => {
  await withSchema(async (db, url) => {
    await db.query(await readFile("db/001_init.sql", "utf8"));
    await db.query(await readFile("db/002_workflow_config.sql", "utf8"));
    await db.query(
      "CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.query(
      "INSERT INTO schema_migration (version) VALUES ('001_init'), ('002_workflow_config')",
    );
    const workflow = await db.query<{ id: string }>(
      "INSERT INTO workflow (name, form_id, enabled, enabled_at, config_json) VALUES ('Consultation', 'form', true, '2026-10-08T10:00:00Z', '{}'::jsonb) RETURNING id",
    );
    const id = workflow.rows[0].id;
    await db.query(
      "INSERT INTO form_poll_state (workflow_id, cursor_at) VALUES ($1, '2026-10-08T11:00:00Z')",
      [id],
    );
    await db.query(
      "INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot) VALUES ($1, 'new', '2026-10-08T10:30:00Z', '2026-10-08T10:30:00Z', '{\"sentinel\":true}'::jsonb, '{\"formId\":\"form\"}'::jsonb)",
      [id],
    );
    await db.query(
      "INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json) VALUES ($1, 'legacy', '2026-10-08T10:31:00Z', '2026-10-08T10:31:00Z', '{}'::jsonb)",
      [id],
    );

    await migrate(url);
    const rows = await db.query<{
      response_id: string;
      state: string;
      config_snapshot: unknown;
      answers_json: unknown;
      cursor_at: Date;
    }>(
      "SELECT r.response_id, r.state, r.config_snapshot, r.answers_json, p.cursor_at FROM run r JOIN form_poll_state p ON p.workflow_id = r.workflow_id ORDER BY r.response_id",
    );
    assert.deepEqual(
      rows.rows.map((row) => row.response_id),
      ["legacy", "new"],
    );
    assert.equal(rows.rows[0].config_snapshot, null);
    assert.deepEqual(rows.rows[1].config_snapshot, { formId: "form" });
    assert.deepEqual(rows.rows[1].answers_json, { sentinel: true });
    assert.ok(
      rows.rows.every(
        (row) =>
          row.state === "queued" &&
          row.cursor_at.toISOString() === "2026-10-08T11:00:00.000Z",
      ),
    );
    await assert.rejects(
      db.query("UPDATE run SET state = 'unknown' WHERE response_id = 'new'"),
      /run_state_check/,
    );
    const run = await db.query<{ id: string }>(
      "SELECT id FROM run WHERE response_id = 'new'",
    );
    await db.query(
      "INSERT INTO step_run (run_id, step_name) VALUES ($1, 'filter')",
      [run.rows[0].id],
    );
    await assert.rejects(
      db.query(
        "INSERT INTO step_run (run_id, step_name) VALUES ($1, 'filter')",
        [run.rows[0].id],
      ),
      /step_run_pkey/,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO step_run (run_id, step_name) VALUES ($1, 'other')",
        [run.rows[0].id],
      ),
      /step_run_step_name_check/,
    );
    await assert.rejects(
      db.query("UPDATE step_run SET attempt_count = -1 WHERE run_id = $1", [
        run.rows[0].id,
      ]),
      /step_run_attempt_count_check/,
    );
    await migrate(url);
    assert.equal(
      (await db.query("SELECT version FROM schema_migration")).rowCount,
      5,
    );
  });
});

test("upgrades populated Milestone 03 runs without changing history or cursor", async () => {
  await withSchema(async (db, url) => {
    for (const version of [
      "001_init",
      "002_workflow_config",
      "003_run_execution",
    ]) {
      await db.query(await readFile(`db/${version}.sql`, "utf8"));
    }
    await db.query(
      "CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.query(
      "INSERT INTO schema_migration (version) VALUES ('001_init'), ('002_workflow_config'), ('003_run_execution')",
    );
    const workflow = await db.query<{ id: string }>(
      "INSERT INTO workflow (name, form_id, enabled, enabled_at, config_json) VALUES ('Test', 'form', true, now(), '{}'::jsonb) RETURNING id",
    );
    const workflowId = workflow.rows[0].id;
    await db.query(
      "INSERT INTO form_poll_state (workflow_id, cursor_at) VALUES ($1, '2026-10-08T11:00:00Z')",
      [workflowId],
    );
    const runs = await db.query<{ id: string; response_id: string }>(
      `INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot, state)
       VALUES ($1, 'queued', now(), now(), '{"private":"queued"}'::jsonb, '{"formId":"form"}'::jsonb, 'queued'),
              ($1, 'partial', now(), now(), '{"private":"partial"}'::jsonb, '{"formId":"form"}'::jsonb, 'partially_failed'),
              ($1, 'legacy', now(), now(), '{}'::jsonb, NULL, 'queued')
       RETURNING id, response_id`,
      [workflowId],
    );
    const partial = runs.rows.find((row) => row.response_id === "partial")!;
    await db.query(
      `INSERT INTO step_run (run_id, step_name, state, attempt_count, external_id, started_at, finished_at)
       VALUES ($1, 'filter', 'succeeded', 1, NULL, now(), now()),
              ($1, 'calendar', 'succeeded', 1, 'reserved-event-id', now(), now()),
              ($1, 'gmail', 'uncertain', 1, NULL, now(), now())`,
      [partial.id],
    );
    const before = await db.query(
      "SELECT id, response_id, answers_json, config_snapshot, state, create_time, last_submitted_time FROM run ORDER BY response_id",
    );
    const beforeSteps = await db.query(
      "SELECT run_id, step_name, state, attempt_count, external_id, started_at, finished_at FROM step_run ORDER BY step_name",
    );
    await migrate(url);
    const after = await db.query(
      "SELECT id, response_id, answers_json, config_snapshot, state, create_time, last_submitted_time FROM run ORDER BY response_id",
    );
    const afterSteps = await db.query(
      "SELECT run_id, step_name, state, attempt_count, external_id, started_at, finished_at FROM step_run ORDER BY step_name",
    );
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(afterSteps.rows, beforeSteps.rows);
    const uncertainHistory = await db.query<{ uncertain_send_seen: boolean }>(
      "SELECT uncertain_send_seen FROM step_run WHERE run_id = $1 AND step_name = 'gmail'",
      [partial.id],
    );
    assert.equal(uncertainHistory.rows[0].uncertain_send_seen, true);
    assert.equal(
      (
        await db.query(
          "SELECT cursor_at FROM form_poll_state WHERE workflow_id = $1",
          [workflowId],
        )
      ).rows[0].cursor_at.toISOString(),
      "2026-10-08T11:00:00.000Z",
    );
    const defaults = await db.query<{
      next_attempt_at: Date | null;
      retry_mode: string;
      lookup_attempt_count: number;
    }>(
      "SELECT next_attempt_at, retry_mode, lookup_attempt_count FROM step_run WHERE run_id = $1",
      [partial.id],
    );
    assert.ok(
      defaults.rows.every(
        (row) =>
          row.next_attempt_at === null &&
          row.retry_mode === "automatic" &&
          row.lookup_attempt_count === 0,
      ),
    );
    await assert.rejects(
      db.query("UPDATE step_run SET retry_mode = 'invalid' WHERE run_id = $1", [
        partial.id,
      ]),
      /step_run_retry_mode_check/,
    );
    await assert.rejects(
      db.query(
        "UPDATE step_run SET lookup_attempt_count = -1 WHERE run_id = $1",
        [partial.id],
      ),
      /step_run_lookup_attempt_count_check/,
    );
    await migrate(url);
    assert.equal(
      (await db.query("SELECT version FROM schema_migration")).rowCount,
      5,
    );
  });
});

test("upgrades Milestone 01 records without losing run or cursor data", async () => {
  await withSchema(async (db, url) => {
    await db.query(await readFile("db/001_init.sql", "utf8"));
    const workflow = await db.query<{ id: string }>(
      "INSERT INTO workflow (name, form_id, enabled, enabled_at) VALUES ('Legacy', 'old-form', true, '2026-10-08T10:00:00Z') RETURNING id",
    );
    const id = workflow.rows[0].id;
    await db.query(
      "INSERT INTO form_poll_state (workflow_id, cursor_at) VALUES ($1, '2026-10-08T11:00:00Z')",
      [id],
    );
    await db.query(
      "INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json) VALUES ($1, 'old-response', '2026-10-08T10:30:00Z', '2026-10-08T10:30:00Z', '{}'::jsonb)",
      [id],
    );

    await migrate(url);
    const saved = await db.query<{
      enabled: boolean;
      cursor_at: Date;
      response_id: string;
      config_snapshot: unknown;
      answers_json: Record<string, unknown>;
      create_time: Date;
      last_submitted_time: Date;
    }>(
      `SELECT w.enabled, p.cursor_at, r.response_id, r.config_snapshot,
              r.answers_json, r.create_time, r.last_submitted_time
       FROM workflow w JOIN form_poll_state p ON p.workflow_id = w.id
       JOIN run r ON r.workflow_id = w.id WHERE w.id = $1`,
      [id],
    );
    assert.equal(saved.rows[0].enabled, false);
    assert.equal(
      saved.rows[0].cursor_at.toISOString(),
      "2026-10-08T11:00:00.000Z",
    );
    assert.equal(saved.rows[0].response_id, "old-response");
    assert.equal(saved.rows[0].config_snapshot, null);
    assert.deepEqual(saved.rows[0].answers_json, {});
    assert.equal(
      saved.rows[0].create_time.toISOString(),
      "2026-10-08T10:30:00.000Z",
    );
    assert.equal(
      saved.rows[0].last_submitted_time.toISOString(),
      "2026-10-08T10:30:00.000Z",
    );
    await migrate(url);
    assert.equal(
      (await db.query("SELECT id FROM run WHERE workflow_id = $1", [id]))
        .rowCount,
      1,
    );
  });
});
