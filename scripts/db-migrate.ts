import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  const sql = await readFile(resolve("db/001_init.sql"), "utf8");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("Applied db/001_init.sql");
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
