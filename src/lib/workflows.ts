import type { Pool } from "pg";
import { getDb } from "./db";
import {
  hasCompleteWorkflowFields,
  validateWorkflowConfig,
  type FormMetadata,
} from "./workflow-config";

export type Workflow = {
  id: string;
  name: string;
  formId: string;
  config: Record<string, unknown> | null;
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
  config_json: Record<string, unknown> | null;
  enabled: boolean;
  enabled_at: Date | null;
  cursor_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const selectWorkflows = `
  SELECT w.id, w.name, w.form_id, w.config_json, w.enabled, w.enabled_at,
         p.cursor_at, w.created_at, w.updated_at
  FROM workflow w
  JOIN form_poll_state p ON p.workflow_id = w.id
`;

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    formId: row.form_id,
    config: row.config_json,
    enabled: row.enabled,
    enabledAt: row.enabled_at,
    cursorAt: row.cursor_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type WorkflowInput = { name: string; formId: string; config?: unknown };

function normalizeInput(input: WorkflowInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const formId = typeof input.formId === "string" ? input.formId.trim() : "";
  if (!name) throw new Error("Workflow name is required");
  if (!formId) throw new Error("Form ID is required");
  return { name, formId };
}

function prepareConfig(
  config: unknown,
  formId: string,
  metadata?: FormMetadata,
): Record<string, unknown> | null {
  if (metadata) {
    if (metadata.formId !== formId)
      throw new Error("Form metadata does not match Form ID");
    return validateWorkflowConfig(config, metadata);
  }
  if (config == null) return null;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Workflow draft must be an object");
  }
  if (hasCompleteWorkflowFields(config)) {
    throw new Error("Form metadata is required to save a complete workflow");
  }
  return config as Record<string, unknown>;
}

export async function saveWorkflow(
  input: WorkflowInput,
  db: Pool = getDb(),
  metadata?: FormMetadata,
): Promise<Workflow> {
  const { name, formId } = normalizeInput(input);
  const config = prepareConfig(input.config, formId, metadata);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query<{ id: string }>(
      "INSERT INTO workflow (name, form_id, config_json) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [name, formId, config === null ? null : JSON.stringify(config)],
    );
    const id = saved.rows[0].id;
    await client.query(
      "INSERT INTO form_poll_state (workflow_id) VALUES ($1)",
      [id],
    );
    const result = await client.query<WorkflowRow>(
      `${selectWorkflows} WHERE w.id = $1`,
      [id],
    );
    await client.query("COMMIT");
    return toWorkflow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWorkflow(
  id: string,
  input: WorkflowInput,
  db: Pool = getDb(),
  metadata?: FormMetadata,
): Promise<Workflow> {
  const { name, formId } = normalizeInput(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<WorkflowRow>(
      "SELECT form_id, config_json, enabled FROM workflow WHERE id = $1 FOR UPDATE",
      [id],
    );
    const current = existing.rows[0];
    if (!current) throw new Error("Workflow not found");
    if (current.enabled && current.form_id !== formId) {
      throw new Error("Disable the workflow before changing its Form ID");
    }
    if (current.enabled && input.config !== undefined && !metadata) {
      throw new Error("Form metadata is required to edit an enabled workflow");
    }
    const config =
      input.config === undefined && current.form_id !== formId && !metadata
        ? null
        : input.config === undefined
          ? current.config_json
          : input.config;
    const prepared =
      input.config === undefined && !metadata
        ? config
        : prepareConfig(config, formId, metadata);
    await client.query(
      "UPDATE workflow SET name = $2, form_id = $3, config_json = $4::jsonb, updated_at = now() WHERE id = $1",
      [id, name, formId, prepared === null ? null : JSON.stringify(prepared)],
    );
    const result = await client.query<WorkflowRow>(
      `${selectWorkflows} WHERE w.id = $1`,
      [id],
    );
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
  metadata?: FormMetadata,
): Promise<Workflow> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<WorkflowRow>(
      "SELECT form_id, config_json FROM workflow WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (current.rowCount === 0) throw new Error("Workflow not found");
    let config = current.rows[0].config_json;
    if (enabled) {
      if (!metadata || metadata.formId !== current.rows[0].form_id) {
        throw new Error("Form metadata is required for this Form ID");
      }
      config = validateWorkflowConfig(config, metadata);
    }
    const updated = await client.query(
      `UPDATE workflow
       SET enabled = $2, enabled_at = CASE WHEN $2 THEN $3 ELSE enabled_at END,
           config_json = $4::jsonb, updated_at = $3
       WHERE id = $1 RETURNING id`,
      [id, enabled, now, config === null ? null : JSON.stringify(config)],
    );
    if (updated.rowCount === 0) throw new Error("Workflow not found");
    if (enabled) {
      await client.query(
        "UPDATE form_poll_state SET cursor_at = $2 WHERE workflow_id = $1",
        [id, now],
      );
    }
    const result = await client.query<WorkflowRow>(
      `${selectWorkflows} WHERE w.id = $1`,
      [id],
    );
    await client.query("COMMIT");
    return toWorkflow(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkflow(
  id: string,
  db: Pool = getDb(),
): Promise<Workflow | null> {
  const result = await db.query<WorkflowRow>(
    `${selectWorkflows} WHERE w.id = $1`,
    [id],
  );
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

export async function listWorkflows(db: Pool = getDb()): Promise<Workflow[]> {
  const result = await db.query<WorkflowRow>(
    `${selectWorkflows} ORDER BY w.created_at DESC, w.id DESC`,
  );
  return result.rows.map(toWorkflow);
}

export async function listEnabledWorkflows(
  db: Pool = getDb(),
): Promise<Workflow[]> {
  const result = await db.query<WorkflowRow>(
    `${selectWorkflows} WHERE w.enabled = true ORDER BY w.created_at DESC, w.id DESC`,
  );
  return result.rows.map(toWorkflow);
}
