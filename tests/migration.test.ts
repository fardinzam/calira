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
      ["001_init", "002_workflow_config"],
    );
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'run'",
    );
    assert.ok(
      columns.rows.some((row) => row.column_name === "config_snapshot"),
    );
    await migrate(url);
    const second = await db.query("SELECT version FROM schema_migration");
    assert.equal(second.rowCount, 2);
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
