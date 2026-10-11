export type ActionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      certainty: "rejected";
      code: string;
      message: string;
      retryable?: boolean;
    }
  | {
      ok: false;
      certainty: "unknown";
      code: string;
      message: string;
    };

export type CalendarEventInput = {
  calendarId: string;
  eventId: string;
  title: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: "America/Los_Angeles";
};

export type GmailMessageInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type CalendarClient = {
  insertEvent(
    input: CalendarEventInput,
  ): Promise<ActionResult<{ eventId: string }>>;
};

export type CalendarLookupResult =
  | { kind: "found_match"; eventId: string }
  | { kind: "found_mismatch" }
  | { kind: "not_found" }
  | { kind: "unavailable"; code: string; message: string; retryable: boolean };

export type CalendarLookupClient = {
  lookupEvent(input: CalendarEventInput): Promise<CalendarLookupResult>;
};

export type GmailClient = {
  sendMessage(
    input: GmailMessageInput,
  ): Promise<ActionResult<{ messageId: string }>>;
};

export type RunDetail = {
  id: string;
  responseId: string;
  submittedAt: Date;
  state:
    | "queued"
    | "running"
    | "filtered_out"
    | "succeeded"
    | "failed"
    | "partially_failed";
  detectionOnly: boolean;
  workflowEnabled: boolean;
  gmailRetry: "none" | "definite" | "uncertain";
  error: { code: string; message: string } | null;
  steps: Array<{
    name: "filter" | "calendar" | "gmail";
    state:
      "pending" | "running" | "succeeded" | "skipped" | "failed" | "uncertain";
    attemptCount: number;
    nextAttemptAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    summary: string | null;
    externalId: string | null;
    error: { code: string; message: string } | null;
  }>;
};

export type ClaimedRun = {
  id: string;
  answers: Record<string, unknown>;
  snapshot: unknown;
};

const stepNames = ["filter", "calendar", "gmail"] as const;

async function transaction<T>(
  db: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function requireUpdated(count: number | null, label: string): void {
  if (count !== 1) throw new Error(`Invalid ${label} transition`);
}

async function lockRunning(client: PoolClient, runId: string): Promise<void> {
  const result = await client.query(
    "SELECT id FROM run WHERE id = $1 AND state = 'running' FOR UPDATE",
    [runId],
  );
  requireUpdated(result.rowCount, "run");
}

export async function claimNextRun(
  db: Pool = getDb(),
  now: Date = new Date(),
): Promise<ClaimedRun | null> {
  return transaction(db, async (client) => {
    const result = await client.query<{
      id: string;
      answers_json: Record<string, unknown>;
      config_snapshot: unknown;
    }>(
      `SELECT r.id, r.answers_json, r.config_snapshot
       FROM run r JOIN workflow w ON w.id = r.workflow_id
       WHERE r.state = 'queued' AND r.config_snapshot IS NOT NULL AND w.enabled = true
         AND (
           NOT EXISTS (SELECT 1 FROM step_run s WHERE s.run_id = r.id)
           OR EXISTS (
             SELECT 1 FROM step_run s WHERE s.run_id = r.id
               AND s.state = 'pending' AND s.step_name IN ('calendar', 'gmail')
               AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= $1)
               AND (
                 (s.step_name = 'calendar' AND EXISTS (
                   SELECT 1 FROM step_run f WHERE f.run_id = r.id
                     AND f.step_name = 'filter' AND f.state = 'succeeded'
                 ))
                 OR (s.step_name = 'gmail' AND EXISTS (
                   SELECT 1 FROM step_run c WHERE c.run_id = r.id
                     AND c.step_name = 'calendar' AND c.state = 'succeeded'
                 ))
               )
           )
         )
       ORDER BY r.created_at, r.id LIMIT 1
       FOR UPDATE OF r, w SKIP LOCKED`,
      [now],
    );
    const row = result.rows[0];
    if (!row) return null;
    requireUpdated(
      (
        await client.query(
          "UPDATE run SET state = 'running', started_at = COALESCE(started_at, $2), finished_at = NULL WHERE id = $1 AND state = 'queued'",
          [row.id, now],
        )
      ).rowCount,
      "claim",
    );
    await client.query(
      `INSERT INTO step_run (run_id, step_name)
       SELECT $1, names.step_name FROM unnest(ARRAY['filter', 'calendar', 'gmail']) AS names(step_name)
       WHERE NOT EXISTS (SELECT 1 FROM step_run WHERE run_id = $1)`,
      [row.id],
    );
    return {
      id: row.id,
      answers: row.answers_json,
      snapshot: row.config_snapshot,
    };
  });
}

export async function listRunningRuns(
  db: Pool = getDb(),
): Promise<ClaimedRun[]> {
  const result = await db.query<{
    id: string;
    answers_json: Record<string, unknown>;
    config_snapshot: unknown;
  }>(
    `SELECT id, answers_json, config_snapshot FROM run
     WHERE state = 'running' AND config_snapshot IS NOT NULL
     ORDER BY created_at, id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    answers: row.answers_json,
    snapshot: row.config_snapshot,
  }));
}

async function skipActions(client: PoolClient, runId: string): Promise<void> {
  const result = await client.query(
    `UPDATE step_run SET state = 'skipped', finished_at = now()
     WHERE run_id = $1 AND step_name IN ('calendar', 'gmail') AND state = 'pending'`,
    [runId],
  );
  if (result.rowCount !== 2) throw new Error("Invalid action skip transition");
}

export async function markFilteredOut(
  runId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'succeeded', attempt_count = 1,
         started_at = now(), finished_at = now(), result_summary = 'Filter did not match'
         WHERE run_id = $1 AND step_name = 'filter' AND state = 'pending'`,
          [runId],
        )
      ).rowCount,
      "filter",
    );
    await skipActions(client, runId);
    await client.query(
      "UPDATE run SET state = 'filtered_out', finished_at = now() WHERE id = $1",
      [runId],
    );
  });
}

export async function markFilterFailed(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'failed', attempt_count = 1, started_at = now(),
         finished_at = now(), error_code = $2, error_message = $3
         WHERE run_id = $1 AND step_name = 'filter' AND state = 'pending'`,
          [runId, code, message],
        )
      ).rowCount,
      "filter",
    );
    await skipActions(client, runId);
    await client.query(
      "UPDATE run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3 WHERE id = $1",
      [runId, code, message],
    );
  });
}

export async function markValidationFailed(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    const filter = await client.query<{ state: string }>(
      "SELECT state FROM step_run WHERE run_id = $1 AND step_name = 'filter' FOR UPDATE",
      [runId],
    );
    if (filter.rows[0]?.state === "pending") {
      requireUpdated(
        (
          await client.query(
            `UPDATE step_run SET state = 'succeeded', attempt_count = 1,
             started_at = now(), finished_at = now(), result_summary = 'Filter matched'
             WHERE run_id = $1 AND step_name = 'filter' AND state = 'pending'`,
            [runId],
          )
        ).rowCount,
        "filter",
      );
    } else if (filter.rows[0]?.state !== "succeeded") {
      throw new Error("Invalid validation failure transition");
    }
    await skipActions(client, runId);
    await client.query(
      "UPDATE run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3 WHERE id = $1",
      [runId, code, message],
    );
  });
}

export async function markFilterMatched(
  runId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'succeeded', attempt_count = 1,
         started_at = now(), finished_at = now(), result_summary = 'Filter matched'
         WHERE run_id = $1 AND step_name = 'filter' AND state = 'pending'`,
          [runId],
        )
      ).rowCount,
      "filter",
    );
  });
}

export async function startCalendar(
  runId: string,
  db: Pool = getDb(),
): Promise<string> {
  const eventId = `a${runId.replaceAll("-", "")}`;
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'running', attempt_count = attempt_count + 1,
         started_at = now(), finished_at = NULL, external_id = COALESCE(external_id, $2),
         next_attempt_at = NULL, error_code = NULL, error_message = NULL
         WHERE run_id = $1 AND step_name = 'calendar' AND state = 'pending'
         AND (external_id IS NULL OR external_id = $2)
         AND EXISTS (SELECT 1 FROM step_run WHERE run_id = $1 AND step_name = 'filter' AND state = 'succeeded')`,
          [runId, eventId],
        )
      ).rowCount,
      "calendar start",
    );
  });
  return eventId;
}

export async function finishCalendarSucceeded(
  runId: string,
  eventId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'succeeded', finished_at = now(), result_summary = 'Event created',
           next_attempt_at = NULL, error_code = NULL, error_message = NULL
         WHERE run_id = $1 AND step_name = 'calendar' AND state IN ('running', 'pending') AND external_id = $2`,
          [runId, eventId],
        )
      ).rowCount,
      "calendar success",
    );
  });
}

export async function finishCalendarRejected(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3
         WHERE run_id = $1 AND step_name = 'calendar' AND state IN ('running', 'pending')`,
          [runId, code, message],
        )
      ).rowCount,
      "calendar rejection",
    );
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'skipped', finished_at = now()
         WHERE run_id = $1 AND step_name = 'gmail' AND state = 'pending'`,
          [runId],
        )
      ).rowCount,
      "gmail skip",
    );
    await client.query(
      "UPDATE run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3 WHERE id = $1",
      [runId, code, message],
    );
  });
}

export async function startGmail(
  runId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'running', attempt_count = attempt_count + 1, started_at = now(),
           finished_at = NULL, next_attempt_at = NULL, error_code = NULL, error_message = NULL
         WHERE run_id = $1 AND step_name = 'gmail' AND state = 'pending'
         AND EXISTS (SELECT 1 FROM step_run WHERE run_id = $1 AND step_name = 'calendar' AND state = 'succeeded')`,
          [runId],
        )
      ).rowCount,
      "gmail start",
    );
  });
}

export async function finishGmailSucceeded(
  runId: string,
  messageId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'succeeded', finished_at = now(), external_id = $2,
         result_summary = 'Message accepted for sending'
         WHERE run_id = $1 AND step_name = 'gmail' AND state = 'running'`,
          [runId, messageId],
        )
      ).rowCount,
      "gmail success",
    );
    await client.query(
      "UPDATE run SET state = 'succeeded', finished_at = now() WHERE id = $1",
      [runId],
    );
  });
}

export async function finishGmailRejected(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3
         WHERE run_id = $1 AND step_name = 'gmail' AND state = 'running'`,
          [runId, code, message],
        )
      ).rowCount,
      "gmail rejection",
    );
    await client.query(
      "UPDATE run SET state = 'partially_failed', finished_at = now(), error_code = $2, error_message = $3 WHERE id = $1",
      [runId, code, message],
    );
  });
}

export async function markGmailPreflightFailed(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'failed', finished_at = now(),
           next_attempt_at = NULL, error_code = $2, error_message = $3
           WHERE run_id = $1 AND step_name = 'gmail' AND state = 'pending'
             AND EXISTS (SELECT 1 FROM step_run WHERE run_id = $1
               AND step_name = 'calendar' AND state = 'succeeded')`,
          [runId, code, message],
        )
      ).rowCount,
      "Gmail preflight failure",
    );
    await client.query(
      `UPDATE run SET state = 'partially_failed', finished_at = now(),
       error_code = $2, error_message = $3 WHERE id = $1`,
      [runId, code, message],
    );
  });
}

function retryDelayMs(count: number): number {
  return count === 1 ? 60_000 : 300_000;
}

async function scheduleRetry(
  runId: string,
  stepName: "calendar" | "gmail",
  code: string,
  message: string,
  now: Date,
  db: Pool,
): Promise<boolean> {
  return transaction(db, async (client) => {
    await lockRunning(client, runId);
    const step = await client.query<{
      attempt_count: number;
      retry_mode: string;
    }>(
      `SELECT attempt_count, retry_mode FROM step_run
       WHERE run_id = $1 AND step_name = $2 AND state = 'running' FOR UPDATE`,
      [runId, stepName],
    );
    if (!step.rows[0]) throw new Error(`Invalid ${stepName} retry transition`);
    if (
      step.rows[0].retry_mode !== "automatic" ||
      step.rows[0].attempt_count >= 3
    ) {
      return false;
    }
    const due = new Date(
      now.getTime() + retryDelayMs(step.rows[0].attempt_count),
    );
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'pending', next_attempt_at = $3,
           error_code = $4, error_message = $5, finished_at = NULL
           WHERE run_id = $1 AND step_name = $2 AND state = 'running'`,
          [runId, stepName, due, code, message],
        )
      ).rowCount,
      `${stepName} retry`,
    );
    await client.query(
      "UPDATE run SET state = 'queued', finished_at = NULL, error_code = NULL, error_message = NULL WHERE id = $1",
      [runId],
    );
    return true;
  });
}

export function scheduleCalendarRetry(
  runId: string,
  code: string,
  message: string,
  now: Date = new Date(),
  db: Pool = getDb(),
): Promise<boolean> {
  return scheduleRetry(runId, "calendar", code, message, now, db);
}

export function scheduleGmailRetry(
  runId: string,
  code: string,
  message: string,
  now: Date = new Date(),
  db: Pool = getDb(),
): Promise<boolean> {
  return scheduleRetry(runId, "gmail", code, message, now, db);
}

export async function startCalendarLookup(
  runId: string,
  now: Date = new Date(),
  db: Pool = getDb(),
): Promise<number> {
  return transaction(db, async (client) => {
    await lockRunning(client, runId);
    const result = await client.query<{ lookup_attempt_count: number }>(
      `UPDATE step_run SET lookup_attempt_count = lookup_attempt_count + 1
       WHERE run_id = $1 AND step_name = 'calendar'
         AND state IN ('pending', 'running') AND external_id IS NOT NULL
         AND lookup_attempt_count < 3
         AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
       RETURNING lookup_attempt_count`,
      [runId, now],
    );
    if (!result.rows[0]) {
      const exhausted = await client.query<{ lookup_attempt_count: number }>(
        `SELECT lookup_attempt_count FROM step_run WHERE run_id = $1
         AND step_name = 'calendar' AND state IN ('pending', 'running')`,
        [runId],
      );
      if (exhausted.rows[0]?.lookup_attempt_count >= 3) return 0;
      throw new Error("Invalid Calendar lookup transition");
    }
    return result.rows[0].lookup_attempt_count;
  });
}

export async function scheduleCalendarLookup(
  runId: string,
  code: string,
  message: string,
  now: Date = new Date(),
  db: Pool = getDb(),
): Promise<boolean> {
  return transaction(db, async (client) => {
    await lockRunning(client, runId);
    const step = await client.query<{ lookup_attempt_count: number }>(
      `SELECT lookup_attempt_count FROM step_run
       WHERE run_id = $1 AND step_name = 'calendar' AND state IN ('pending', 'running') FOR UPDATE`,
      [runId],
    );
    if (!step.rows[0] || step.rows[0].lookup_attempt_count < 1) {
      throw new Error("Invalid Calendar lookup schedule");
    }
    if (step.rows[0].lookup_attempt_count >= 3) return false;
    const due = new Date(
      now.getTime() + retryDelayMs(step.rows[0].lookup_attempt_count),
    );
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET next_attempt_at = $2, error_code = $3, error_message = $4
           WHERE run_id = $1 AND step_name = 'calendar' AND state IN ('pending', 'running')`,
          [runId, due, code, message],
        )
      ).rowCount,
      "Calendar lookup schedule",
    );
    return true;
  });
}

export async function markCalendarUncertain(
  runId: string,
  code: string,
  message: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'uncertain', finished_at = now(), next_attempt_at = NULL,
           error_code = $2, error_message = $3
           WHERE run_id = $1 AND step_name = 'calendar' AND state IN ('pending', 'running')`,
          [runId, code, message],
        )
      ).rowCount,
      "Calendar uncertain",
    );
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'skipped', finished_at = now()
           WHERE run_id = $1 AND step_name = 'gmail' AND state = 'pending'`,
          [runId],
        )
      ).rowCount,
      "Gmail skip",
    );
    await client.query(
      "UPDATE run SET state = 'failed', finished_at = now(), error_code = $2, error_message = $3 WHERE id = $1",
      [runId, code, message],
    );
  });
}

export async function markGmailUncertain(
  runId: string,
  db: Pool = getDb(),
): Promise<void> {
  await transaction(db, async (client) => {
    await lockRunning(client, runId);
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'uncertain', uncertain_send_seen = true,
           finished_at = now(), next_attempt_at = NULL,
           error_code = 'gmail_outcome_unknown', error_message = 'Message may have been sent'
           WHERE run_id = $1 AND step_name = 'gmail' AND state = 'running'
             AND EXISTS (SELECT 1 FROM step_run WHERE run_id = $1 AND step_name = 'calendar' AND state = 'succeeded')`,
          [runId],
        )
      ).rowCount,
      "Gmail uncertain",
    );
    await client.query(
      `UPDATE run SET state = 'partially_failed', finished_at = now(),
       error_code = 'gmail_outcome_unknown', error_message = 'Message may have been sent'
       WHERE id = $1`,
      [runId],
    );
  });
}

export async function requestGmailRetry(
  runId: string,
  acknowledgeDuplicateRisk: boolean,
  db: Pool = getDb(),
): Promise<"queued" | "not_allowed" | "warning_required"> {
  return transaction(db, async (client) => {
    const run = await client.query(
      `SELECT id FROM run WHERE id = $1 AND state = 'partially_failed'
       AND config_snapshot IS NOT NULL FOR UPDATE`,
      [runId],
    );
    if (!run.rows[0]) return "not_allowed";
    const steps = await client.query<{
      step_name: string;
      state: string;
      external_id: string | null;
      uncertain_send_seen: boolean;
    }>(
      `SELECT step_name, state, external_id, uncertain_send_seen FROM step_run
       WHERE run_id = $1 AND step_name IN ('calendar', 'gmail')
       ORDER BY step_name FOR UPDATE`,
      [runId],
    );
    const calendar = steps.rows.find((step) => step.step_name === "calendar");
    const gmail = steps.rows.find((step) => step.step_name === "gmail");
    if (
      calendar?.state !== "succeeded" ||
      !calendar.external_id ||
      (gmail?.state !== "failed" && gmail?.state !== "uncertain") ||
      gmail.external_id !== null
    ) {
      return "not_allowed";
    }
    if (
      (gmail.state === "uncertain" || gmail.uncertain_send_seen) &&
      acknowledgeDuplicateRisk !== true
    ) {
      return "warning_required";
    }
    requireUpdated(
      (
        await client.query(
          `UPDATE step_run SET state = 'pending', retry_mode = 'manual',
           next_attempt_at = now(), finished_at = NULL,
           error_code = NULL, error_message = NULL
           WHERE run_id = $1 AND step_name = 'gmail' AND state IN ('failed', 'uncertain')`,
          [runId],
        )
      ).rowCount,
      "manual Gmail retry",
    );
    requireUpdated(
      (
        await client.query(
          `UPDATE run SET state = 'queued', finished_at = NULL,
           error_code = NULL, error_message = NULL
           WHERE id = $1 AND state = 'partially_failed'`,
          [runId],
        )
      ).rowCount,
      "manual Gmail queue",
    );
    return "queued";
  });
}

export async function withWorkerLock<T>(
  db: Pool,
  work: (assertActive: () => Promise<void>) => Promise<T>,
): Promise<T | null> {
  const client = await db.connect();
  let active = true;
  let acquired = false;
  const onError = () => {
    active = false;
  };
  client.on("error", onError);
  client.on("end", onError);
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(48274, 4) AS acquired",
    );
    if (!lock.rows[0].acquired) return null;
    acquired = true;
    const assertActive = async () => {
      if (!active) throw new Error("Worker lock connection lost");
      try {
        await client.query("SELECT 1");
      } catch {
        active = false;
        throw new Error("Worker lock connection lost");
      }
    };
    const result = await work(assertActive);
    await assertActive();
    return result;
  } finally {
    client.off("error", onError);
    client.off("end", onError);
    if (active && acquired) {
      await client.query("SELECT pg_advisory_unlock(48274, 4)").catch(() => {
        active = false;
      });
    }
    client.release(!active);
  }
}

type DetailRow = {
  id: string;
  response_id: string;
  last_submitted_time: Date;
  run_state: RunDetail["state"];
  detection_only: boolean;
  workflow_enabled: boolean;
  run_error_code: string | null;
  run_error_message: string | null;
  step_name: RunDetail["steps"][number]["name"] | null;
  step_state: RunDetail["steps"][number]["state"] | null;
  attempt_count: number | null;
  next_attempt_at: Date | null;
  step_started_at: Date | null;
  step_finished_at: Date | null;
  result_summary: string | null;
  external_id: string | null;
  step_error_code: string | null;
  step_error_message: string | null;
  uncertain_send_seen: boolean | null;
};

export async function getRunDetail(
  runId: string,
  db: Pool = getDb(),
): Promise<RunDetail | null> {
  const result = await db.query<DetailRow>(
    `SELECT r.id, r.response_id, r.last_submitted_time, r.state AS run_state,
            r.config_snapshot IS NULL AS detection_only,
            w.enabled AS workflow_enabled,
            r.error_code AS run_error_code, r.error_message AS run_error_message,
            s.step_name, s.state AS step_state, s.attempt_count, s.next_attempt_at,
            s.started_at AS step_started_at, s.finished_at AS step_finished_at,
            s.result_summary, s.external_id,
            s.error_code AS step_error_code, s.error_message AS step_error_message,
            s.uncertain_send_seen
     FROM run r JOIN workflow w ON w.id = r.workflow_id
     LEFT JOIN step_run s ON s.run_id = r.id
     WHERE r.id = $1
     ORDER BY CASE s.step_name WHEN 'filter' THEN 1 WHEN 'calendar' THEN 2 WHEN 'gmail' THEN 3 END`,
    [runId],
  );
  if (!result.rows.length) return null;
  const first = result.rows[0];
  const steps: RunDetail["steps"] = first.detection_only
    ? []
    : result.rows
        .filter((row) => row.step_name && row.step_state)
        .map((row) => ({
          name: row.step_name!,
          state: row.step_state!,
          attemptCount: row.attempt_count!,
          nextAttemptAt: row.next_attempt_at,
          startedAt: row.step_started_at,
          finishedAt: row.step_finished_at,
          summary: row.result_summary,
          externalId: row.external_id,
          error:
            row.step_error_code && row.step_error_message
              ? { code: row.step_error_code, message: row.step_error_message }
              : null,
        }));
  if (!steps.length && !first.detection_only && first.run_state === "queued") {
    steps.push(
      ...stepNames.map((name) => ({
        name,
        state: "pending" as const,
        attemptCount: 0,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
        summary: null,
        externalId: null,
        error: null,
      })),
    );
  }
  const calendar = steps.find((step) => step.name === "calendar");
  const gmail = steps.find((step) => step.name === "gmail");
  const gmailRetry =
    !first.detection_only &&
    first.run_state === "partially_failed" &&
    calendar?.state === "succeeded" &&
    calendar.externalId &&
    gmail?.externalId === null &&
    (gmail?.state === "failed" || gmail?.state === "uncertain")
      ? result.rows.find((row) => row.step_name === "gmail")
          ?.uncertain_send_seen || gmail.state === "uncertain"
        ? "uncertain"
        : "definite"
      : "none";
  return {
    id: first.id,
    responseId: first.response_id,
    submittedAt: first.last_submitted_time,
    state: first.run_state,
    detectionOnly: first.detection_only,
    workflowEnabled: first.workflow_enabled,
    gmailRetry,
    error:
      first.run_error_code && first.run_error_message
        ? { code: first.run_error_code, message: first.run_error_message }
        : null,
    steps,
  };
}
import type { Pool, PoolClient } from "pg";
import { getDb } from "./db";
