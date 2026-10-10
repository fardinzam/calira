import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const initialized = await client.query<{ workflow: string | null }>(
      "SELECT to_regclass('workflow')::text AS workflow",
    );
    const recorded = await client.query<{ version: string }>(
      "SELECT version FROM schema_migration",
    );
    const versions = new Set(recorded.rows.map((row) => row.version));

    if (!versions.has("001_init") && initialized.rows[0].workflow) {
      const otherTables = await client.query<{
        poll: string | null;
        run: string | null;
      }>(
        "SELECT to_regclass('form_poll_state')::text AS poll, to_regclass('run')::text AS run",
      );
      if (!otherTables.rows[0].poll || !otherTables.rows[0].run) {
        throw new Error("Existing database does not match Milestone 01 schema");
      }
      await client.query(
        "INSERT INTO schema_migration (version) VALUES ('001_init')",
      );
      versions.add("001_init");
    }

    for (const version of ["001_init", "002_workflow_config"]) {
      if (versions.has(version)) continue;
      const path = `db/${version}.sql`;
      const sql = await readFile(resolve(path), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migration (version) VALUES ($1)", [
        version,
      ]);
      console.log(`Applied ${path}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Database migration failed",
  );
  process.exitCode = 1;
});
