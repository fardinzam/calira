import type { Pool, PoolClient } from "pg";
import { getDb } from "./db";
import type { RunConfigSnapshot } from "./workflow-config";

export type FormResponse = {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  answers: Record<string, unknown>;
};

export type Run = {
  id: string;
  workflowId: string;
  responseId: string;
  createTime: Date;
  lastSubmittedTime: Date;
  answers: Record<string, unknown>;
  configSnapshot: RunConfigSnapshot | null;
  state: string;
  createdAt: Date;
};

type RunRow = {
  id: string;
  workflow_id: string;
  response_id: string;
  create_time: Date;
  last_submitted_time: Date;
  answers_json: Record<string, unknown>;
  config_snapshot: RunConfigSnapshot | null;
  state: string;
  created_at: Date;
};

export async function insertRunIfAbsent(
  workflowId: string,
  response: FormResponse,
  db: Pool | PoolClient = getDb(),
  snapshot: RunConfigSnapshot | null = null,
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (workflow_id, response_id) DO NOTHING
     RETURNING id`,
    [
      workflowId,
      response.responseId,
      response.createTime,
      response.lastSubmittedTime,
      JSON.stringify(response.answers),
      snapshot === null ? null : JSON.stringify(snapshot),
    ],
  );
  return result.rowCount === 1;
}

export async function listRuns(db: Pool = getDb()): Promise<Run[]> {
  const result = await db.query<RunRow>(
    `SELECT id, workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot, state, created_at
     FROM run ORDER BY created_at DESC, id DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    responseId: row.response_id,
    createTime: row.create_time,
    lastSubmittedTime: row.last_submitted_time,
    answers: row.answers_json,
    configSnapshot: row.config_snapshot,
    state: row.state,
    createdAt: row.created_at,
  }));
}
