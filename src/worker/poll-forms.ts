import type { Pool } from "pg";
import { insertRunIfAbsent, type FormResponse } from "../lib/runs";
import { listEnabledWorkflows } from "../lib/workflows";

type FormsClient = {
  listFormResponses(
    formId: string,
    since: Date,
    pageToken?: string,
  ): Promise<{
    responses: FormResponse[];
    nextPageToken?: string;
  }>;
};

type PollRow = {
  form_id: string;
  enabled: boolean;
  enabled_at: Date | null;
  cursor_at: Date | null;
};

function sameTime(left: Date | null, right: Date | null): boolean {
  return left?.getTime() === right?.getTime();
}

export async function pollWorkflow(
  workflowId: string,
  formsClient: FormsClient,
  db: Pool,
): Promise<void> {
  const client = await db.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
      [workflowId],
    );
    locked = lock.rows[0].acquired;
    if (!locked) return;

    const starting = await client.query<PollRow>(
      `SELECT w.form_id, w.enabled, w.enabled_at, p.cursor_at
       FROM workflow w JOIN form_poll_state p ON p.workflow_id = w.id
       WHERE w.id = $1`,
      [workflowId],
    );
    const workflow = starting.rows[0];
    if (!workflow?.enabled || !workflow.enabled_at) return;

    const since = workflow.cursor_at ?? workflow.enabled_at;
    const responses: FormResponse[] = [];
    let pageToken: string | undefined;
    do {
      const page = await formsClient.listFormResponses(
        workflow.form_id,
        since,
        pageToken,
      );
      responses.push(...page.responses);
      pageToken = page.nextPageToken;
    } while (pageToken);

    await client.query("BEGIN");
    try {
      const current = await client.query<PollRow>(
        `SELECT w.form_id, w.enabled, w.enabled_at, p.cursor_at
         FROM workflow w JOIN form_poll_state p ON p.workflow_id = w.id
         WHERE w.id = $1 FOR UPDATE OF w, p`,
        [workflowId],
      );
      const latest = current.rows[0];
      if (
        !latest?.enabled ||
        !sameTime(latest.enabled_at, workflow.enabled_at) ||
        !sameTime(latest.cursor_at, workflow.cursor_at) ||
        latest.form_id !== workflow.form_id
      ) {
        await client.query("ROLLBACK");
        return;
      }

      let cursor = since;
      for (const response of responses) {
        if (Date.parse(response.createTime) >= workflow.enabled_at.getTime()) {
          await insertRunIfAbsent(workflowId, response, client);
        }
        const submitted = new Date(response.lastSubmittedTime);
        if (submitted > cursor) cursor = submitted;
      }
      await client.query(
        `UPDATE form_poll_state
         SET cursor_at = $2, last_checked_at = now(), last_error = NULL
         WHERE workflow_id = $1`,
        [workflowId, cursor],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    try {
      if (locked) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
          [workflowId],
        );
      }
    } finally {
      client.release();
    }
  }
}

export async function pollEnabledWorkflows(
  formsClient: FormsClient,
  db: Pool,
): Promise<string | undefined> {
  let failure: string | undefined;
  for (const workflow of await listEnabledWorkflows(db)) {
    try {
      await pollWorkflow(workflow.id, formsClient, db);
    } catch (error) {
      const revoked =
        error instanceof Error &&
        error.message ===
          "Google authorization expired or revoked; reconnect the owner account";
      failure = revoked
        ? "Google authorization expired or revoked; reconnect the owner account"
        : (failure ?? "Forms polling failed");
    }
  }
  return failure;
}
