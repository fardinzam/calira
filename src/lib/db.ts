import { Pool } from "pg";

let pool: Pool | undefined;

export function getDb(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Missing DATABASE_URL");
    pool = new Pool({ connectionString });
  }
  return pool;
}
