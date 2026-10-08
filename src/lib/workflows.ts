import type { Pool } from "pg";
import { getDb } from "./db";

export type Workflow = {
  id: string;
  name: string;
  formId: string;
  enabled: boolean;
  enabledAt: Date | null;
  cursorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type WorkflowRow = {
  id: string;
  name: string;
  form_id: string;
  enabled: boolean;
  enabled_at: Date | null;
  cursor_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const selectWorkflows = `
  SELECT w.id, w.name, w.form_id, w.enabled, w.enabled_at,
         p.cursor_at, w.created_at, w.updated_at
  FROM workflow w
  JOIN form_poll_state p ON p.workflow_id = w.id
`;

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    formId: row.form_id,
    enabled: row.enabled,
    enabledAt: row.enabled_at,
    cursorAt: row.cursor_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveWorkflow(input: { name: string; formId: string }, db: Pool = getDb()): Promise<Workflow> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const formId = typeof input.formId === "string" ? input.formId.trim() : "";
  if (!name) throw new Error("Workflow name is required");
  if (!formId) throw new Error("Form ID is required");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query<{ id: string }>(
      "INSERT INTO workflow (name, form_id) VALUES ($1, $2) RETURNING id",
      [name, formId],
    );
    const id = saved.rows[0].id;
    await client.query("INSERT INTO form_poll_state (workflow_id) VALUES ($1)", [id]);
    const result = await client.query<WorkflowRow>(`${selectWorkflows} WHERE w.id = $1`, [id]);
    await client.query("COMMIT");
    return toWorkflow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setWorkflowEnabled(
  id: string,
  enabled: boolean,
  now: Date,
  db: Pool = getDb(),
): Promise<Workflow> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE workflow
       SET enabled = $2, enabled_at = CASE WHEN $2 THEN $3 ELSE enabled_at END,
           updated_at = $3
       WHERE id = $1 RETURNING id`,
      [id, enabled, now],
    );
    if (updated.rowCount === 0) throw new Error("Workflow not found");
    if (enabled) {
      await client.query("UPDATE form_poll_state SET cursor_at = $2 WHERE workflow_id = $1", [id, now]);
    }
    const result = await client.query<WorkflowRow>(`${selectWorkflows} WHERE w.id = $1`, [id]);
    await client.query("COMMIT");
    return toWorkflow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkflows(db: Pool = getDb()): Promise<Workflow[]> {
  const result = await db.query<WorkflowRow>(`${selectWorkflows} ORDER BY w.created_at DESC, w.id DESC`);
  return result.rows.map(toWorkflow);
}

export async function listEnabledWorkflows(db: Pool = getDb()): Promise<Workflow[]> {
  const result = await db.query<WorkflowRow>(
    `${selectWorkflows} WHERE w.enabled = true ORDER BY w.created_at DESC, w.id DESC`,
  );
  return result.rows.map(toWorkflow);
}
