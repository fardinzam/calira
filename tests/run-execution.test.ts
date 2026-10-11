import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  getRunDetail,
  claimNextRun,
  markFilteredOut,
  markFilterFailed,
  markValidationFailed,
  markFilterMatched,
  startCalendar,
  finishCalendarSucceeded,
  finishCalendarRejected,
  startGmail,
  finishGmailSucceeded,
  finishGmailRejected,
  scheduleCalendarRetry,
  scheduleGmailRetry,
  scheduleCalendarLookup,
  markCalendarUncertain,
  markGmailUncertain,
  startCalendarLookup,
  withWorkerLock,
} from "../src/lib/run-execution";
import { setWorkflowEnabled } from "../src/lib/workflows";
import { config, metadata } from "./workflow-fixtures";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const admin = new Pool({ connectionString });
after(() => admin.end());

async function withSchema(body: (db: Pool) => Promise<void>) {
  const schema = `m03_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString!);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new Pool({ connectionString: url.toString() });
  try {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "001_init",
      "002_workflow_config",
      "003_run_execution",
      "004_recovery",
    ]) {
      await db.query(await readFile(`db/${file}.sql`, "utf8"));
    }
    await body(db);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

async function fixtureRun(
  db: Pool,
  options: { enabled?: boolean; snapshot?: boolean; responseId?: string } = {},
) {
  const workflow = await db.query<{ id: string }>(
    "INSERT INTO workflow (name, form_id, enabled, enabled_at, config_json) VALUES ('Test', 'form-1', $1, now(), $2::jsonb) RETURNING id",
    [options.enabled ?? true, JSON.stringify(config)],
  );
  const workflowId = workflow.rows[0].id;
  await db.query("INSERT INTO form_poll_state (workflow_id) VALUES ($1)", [
    workflowId,
  ]);
  const run = await db.query<{ id: string }>(
    "INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot) VALUES ($1, $2, now(), now(), $3::jsonb, $4::jsonb) RETURNING id",
    [
      workflowId,
      options.responseId ?? randomUUID(),
      JSON.stringify({ sentinel: "private-answer" }),
      options.snapshot === false
        ? null
        : JSON.stringify({ formId: "form-1", config }),
    ],
  );
  return { workflowId, runId: run.rows[0].id };
}

test("claim skips disabled and legacy runs, resumes queued work after enable, and lets a claimed run finish after disable", async () => {
  await withSchema(async (db) => {
    const disabled = await fixtureRun(db, { enabled: false });
    const legacy = await fixtureRun(db, { snapshot: false });
    assert.equal(await claimNextRun(db), null);
    await setWorkflowEnabled(
      disabled.workflowId,
      true,
      new Date(),
      db,
      metadata,
    );
    const claim = await claimNextRun(db);
    assert.equal(claim?.id, disabled.runId);
    assert.equal(claim?.snapshot !== null, true);
    await setWorkflowEnabled(disabled.workflowId, false, new Date(), db);
    await markFilteredOut(disabled.runId, db);
    assert.equal(
      (await getRunDetail(disabled.runId, db))?.state,
      "filtered_out",
    );
    assert.equal(await claimNextRun(db), null);
    assert.equal((await getRunDetail(legacy.runId, db))?.detectionOnly, true);
  });
});

test("two concurrent claimers cannot claim the same queued run", async () => {
  await withSchema(async (db) => {
    const { runId } = await fixtureRun(db);
    const [one, two] = await Promise.all([claimNextRun(db), claimNextRun(db)]);
    assert.deepEqual([one?.id, two?.id].filter(Boolean), [runId]);
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "running");
    assert.deepEqual(
      detail?.steps.map((step) => step.name),
      ["filter", "calendar", "gmail"],
    );
    assert.ok(detail?.steps.every((step) => step.state === "pending"));
  });
});

test("a workflow lock serializes disable against a queued claim", async () => {
  await withSchema(async (db) => {
    const { workflowId, runId } = await fixtureRun(db);
    const lock = await db.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM workflow WHERE id = $1 FOR UPDATE", [
        workflowId,
      ]);
      const disabling = setWorkflowEnabled(workflowId, false, new Date(), db);
      assert.equal(await claimNextRun(db), null);
      await lock.query("COMMIT");
      await disabling;
      assert.equal(await claimNextRun(db), null);
      assert.equal((await getRunDetail(runId, db))?.state, "queued");
    } finally {
      await lock.query("ROLLBACK").catch(() => {});
      lock.release();
    }
  });
});

test("filter and validation failures stop before action and preserve safe detail", async () => {
  await withSchema(async (db) => {
    const filtered = await fixtureRun(db);
    await claimNextRun(db);
    await markFilteredOut(filtered.runId, db);
    const filteredDetail = await getRunDetail(filtered.runId, db);
    assert.equal(filteredDetail?.state, "filtered_out");
    assert.equal(filteredDetail?.gmailRetry, "none");
    assert.deepEqual(
      filteredDetail?.steps.map((step) => step.state),
      ["succeeded", "skipped", "skipped"],
    );

    const invalidFilter = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterFailed(
      invalidFilter.runId,
      "invalid_filter_input",
      "Request type answer is invalid",
      db,
    );
    assert.deepEqual(
      (await getRunDetail(invalidFilter.runId, db))?.steps.map(
        (step) => step.state,
      ),
      ["failed", "skipped", "skipped"],
    );

    const invalidMapping = await fixtureRun(db);
    await claimNextRun(db);
    await markValidationFailed(
      invalidMapping.runId,
      "invalid_response",
      "Required response value is invalid",
      db,
    );
    const detail = await getRunDetail(invalidMapping.runId, db);
    assert.equal(detail?.state, "failed");
    assert.deepEqual(
      detail?.steps.map((step) => step.state),
      ["succeeded", "skipped", "skipped"],
    );
    assert.equal(detail?.error?.code, "invalid_response");
    assert.equal(detail?.gmailRetry, "none");
    assert.doesNotMatch(JSON.stringify(detail), /private-answer/);
  });
});

test("confirmed Calendar and Gmail boundaries retain IDs and distinguish definite failures", async () => {
  await withSchema(async (db) => {
    const calendarFailure = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(calendarFailure.runId, db);
    const eventId = await startCalendar(calendarFailure.runId, db);
    assert.equal(eventId, `a${calendarFailure.runId.replaceAll("-", "")}`);
    const beforeInsert = await getRunDetail(calendarFailure.runId, db);
    assert.equal(beforeInsert?.steps[1].state, "running");
    assert.equal(beforeInsert?.steps[1].externalId, eventId);
    assert.equal(beforeInsert?.steps[1].attemptCount, 1);
    assert.equal(await claimNextRun(db), null);
    await finishCalendarRejected(
      calendarFailure.runId,
      "calendar_denied",
      "Calendar rejected the event",
      db,
    );
    const failed = await getRunDetail(calendarFailure.runId, db);
    assert.equal(failed?.state, "failed");
    assert.deepEqual(
      failed?.steps.map((step) => step.state),
      ["succeeded", "failed", "skipped"],
    );
    assert.equal(failed?.steps[1].attemptCount, 1);
    assert.equal(failed?.steps[1].externalId, eventId);

    const gmailFailure = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(gmailFailure.runId, db);
    const goodEventId = await startCalendar(gmailFailure.runId, db);
    await finishCalendarSucceeded(gmailFailure.runId, goodEventId, db);
    const beforeGmail = await getRunDetail(gmailFailure.runId, db);
    assert.equal(beforeGmail?.steps[1].state, "succeeded");
    assert.equal(beforeGmail?.steps[1].externalId, goodEventId);
    assert.equal(beforeGmail?.steps[2].state, "pending");
    await startGmail(gmailFailure.runId, db);
    assert.equal(
      (await getRunDetail(gmailFailure.runId, db))?.steps[2].state,
      "running",
    );
    await finishGmailRejected(
      gmailFailure.runId,
      "gmail_denied",
      "Gmail rejected the message",
      db,
    );
    const partial = await getRunDetail(gmailFailure.runId, db);
    assert.equal(partial?.state, "partially_failed");
    assert.deepEqual(
      partial?.steps.map((step) => step.state),
      ["succeeded", "succeeded", "failed"],
    );
    assert.equal(partial?.steps[1].externalId, goodEventId);
    assert.ok(partial?.steps[1].finishedAt);
    assert.equal(partial?.gmailRetry, "definite");

    const success = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(success.runId, db);
    const successEventId = await startCalendar(success.runId, db);
    await finishCalendarSucceeded(success.runId, successEventId, db);
    await startGmail(success.runId, db);
    await finishGmailSucceeded(success.runId, "message-1", db);
    const done = await getRunDetail(success.runId, db);
    assert.equal(done?.state, "succeeded");
    assert.deepEqual(
      done?.steps.map((step) => step.state),
      ["succeeded", "succeeded", "succeeded"],
    );
    assert.equal(done?.steps[2].externalId, "message-1");
    assert.ok(done?.steps.every((step) => step.finishedAt));
    assert.equal(done?.gmailRetry, "none");
    await assert.rejects(startCalendar(success.runId, db));
  });
});

test("queued snapshot detail synthesizes pending steps and legacy detail has none", async () => {
  await withSchema(async (db) => {
    const queued = await fixtureRun(db);
    const legacy = await fixtureRun(db, { snapshot: false });
    await db.query(
      "INSERT INTO step_run (run_id, step_name) VALUES ($1, 'filter')",
      [legacy.runId],
    );
    const detail = await getRunDetail(queued.runId, db);
    assert.deepEqual(
      detail?.steps.map((step) => step.state),
      ["pending", "pending", "pending"],
    );
    assert.equal(detail?.workflowEnabled, true);
    assert.equal(detail?.gmailRetry, "none");
    assert.ok(detail?.steps.every((step) => step.nextAttemptAt === null));
    assert.equal((await getRunDetail(legacy.runId, db))?.steps.length, 0);
    assert.equal((await getRunDetail(legacy.runId, db))?.gmailRetry, "none");
    assert.doesNotMatch(JSON.stringify(detail), /private-answer/);
    assert.equal(await getRunDetail(randomUUID(), db), null);
  });
});

test("detail exposes due time and safe retry eligibility from persisted states", async () => {
  await withSchema(async (db) => {
    const { runId, workflowId } = await fixtureRun(db, { enabled: false });
    const due = new Date("2026-10-09T12:00:00Z");
    await db.query("UPDATE run SET state = 'partially_failed' WHERE id = $1", [
      runId,
    ]);
    await db.query(
      `INSERT INTO step_run (run_id, step_name, state, external_id, next_attempt_at)
       VALUES ($1, 'filter', 'succeeded', NULL, NULL),
              ($1, 'calendar', 'succeeded', 'reserved-event-id', NULL),
              ($1, 'gmail', 'failed', NULL, $2)`,
      [runId, due],
    );
    let detail = await getRunDetail(runId, db);
    assert.equal(detail?.workflowEnabled, false);
    assert.equal(detail?.gmailRetry, "definite");
    assert.equal(
      detail?.steps[2].nextAttemptAt?.toISOString(),
      due.toISOString(),
    );
    assert.doesNotMatch(JSON.stringify(detail), /private-answer/);

    await db.query(
      "UPDATE step_run SET state = 'uncertain' WHERE run_id = $1 AND step_name = 'gmail'",
      [runId],
    );
    detail = await getRunDetail(runId, db);
    assert.equal(detail?.gmailRetry, "uncertain");

    await db.query("UPDATE run SET state = 'queued' WHERE id = $1", [runId]);
    assert.equal((await getRunDetail(runId, db))?.gmailRetry, "none");
    await db.query("UPDATE run SET state = 'running' WHERE id = $1", [runId]);
    assert.equal((await getRunDetail(runId, db))?.gmailRetry, "none");
    await db.query("UPDATE run SET state = 'succeeded' WHERE id = $1", [runId]);
    assert.equal((await getRunDetail(runId, db))?.gmailRetry, "none");
    await db.query("UPDATE run SET state = 'partially_failed' WHERE id = $1", [
      runId,
    ]);
    await db.query(
      "UPDATE step_run SET state = 'uncertain' WHERE run_id = $1 AND step_name = 'calendar'",
      [runId],
    );
    assert.equal((await getRunDetail(runId, db))?.gmailRetry, "none");
    await db.query("UPDATE workflow SET enabled = true WHERE id = $1", [
      workflowId,
    ]);
    assert.equal((await getRunDetail(runId, db))?.workflowEnabled, true);
  });
});

test("due claims preserve step rows and confirmed IDs; disabled and legacy retries stay paused", async () => {
  await withSchema(async (db) => {
    const now = new Date("2026-10-10T12:00:00Z");
    const { runId, workflowId } = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    await finishCalendarSucceeded(runId, eventId, db);
    await startGmail(runId, db);
    assert.equal(
      await scheduleGmailRetry(
        runId,
        "gmail_rate_limited",
        "Gmail rate limited the request",
        now,
        db,
      ),
      true,
    );
    assert.equal(
      await claimNextRun(db, new Date(now.getTime() + 59_000)),
      null,
    );
    await setWorkflowEnabled(workflowId, false, new Date(), db);
    assert.equal(
      await claimNextRun(db, new Date(now.getTime() + 60_000)),
      null,
    );
    await setWorkflowEnabled(workflowId, true, new Date(), db, metadata);
    const [first, second] = await Promise.all([
      claimNextRun(db, new Date(now.getTime() + 60_000)),
      claimNextRun(db, new Date(now.getTime() + 60_000)),
    ]);
    assert.deepEqual([first?.id, second?.id].filter(Boolean), [runId]);
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.steps[1].state, "succeeded");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].state, "pending");
    assert.equal(detail?.steps[2].attemptCount, 1);
    assert.equal(detail?.steps.length, 3);
    const legacy = await fixtureRun(db, { snapshot: false });
    assert.equal(
      await claimNextRun(db, new Date(now.getTime() + 60_000)),
      null,
    );
    assert.equal((await getRunDetail(legacy.runId, db))?.detectionOnly, true);
  });
});

test("retry schedules are bounded and manual mode never starts automatic retry", async () => {
  await withSchema(async (db) => {
    const now = new Date("2026-10-10T12:00:00Z");
    const gmail = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(gmail.runId, db);
    const eventId = await startCalendar(gmail.runId, db);
    await finishCalendarSucceeded(gmail.runId, eventId, db);
    await startGmail(gmail.runId, db);
    assert.equal(
      await scheduleGmailRetry(gmail.runId, "rate", "Rate limited", now, db),
      true,
    );
    assert.equal(
      (
        await getRunDetail(gmail.runId, db)
      )?.steps[2].nextAttemptAt?.toISOString(),
      "2026-10-10T12:01:00.000Z",
    );
    await claimNextRun(db, new Date("2026-10-10T12:01:00Z"));
    await startGmail(gmail.runId, db);
    assert.equal(
      await scheduleGmailRetry(gmail.runId, "rate", "Rate limited", now, db),
      true,
    );
    assert.equal(
      (
        await getRunDetail(gmail.runId, db)
      )?.steps[2].nextAttemptAt?.toISOString(),
      "2026-10-10T12:05:00.000Z",
    );
    await claimNextRun(db, new Date("2026-10-10T12:05:00Z"));
    await startGmail(gmail.runId, db);
    assert.equal(
      await scheduleGmailRetry(gmail.runId, "rate", "Rate limited", now, db),
      false,
    );
    await db.query(
      "UPDATE step_run SET retry_mode = 'manual' WHERE run_id = $1 AND step_name = 'gmail'",
      [gmail.runId],
    );
    assert.equal(
      await scheduleGmailRetry(gmail.runId, "rate", "Rate limited", now, db),
      false,
    );
    await markGmailUncertain(gmail.runId, db);
    assert.equal(
      (await getRunDetail(gmail.runId, db))?.state,
      "partially_failed",
    );

    const calendar = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(calendar.runId, db);
    await startCalendar(calendar.runId, db);
    assert.equal(
      await scheduleCalendarRetry(
        calendar.runId,
        "rate",
        "Rate limited",
        now,
        db,
      ),
      true,
    );
    assert.equal(
      (
        await getRunDetail(calendar.runId, db)
      )?.steps[1].nextAttemptAt?.toISOString(),
      "2026-10-10T12:01:00.000Z",
    );
    await claimNextRun(db, new Date("2026-10-10T12:01:00Z"));
    const retryTime = new Date("2026-10-10T12:01:00Z");
    assert.equal(await startCalendarLookup(calendar.runId, retryTime, db), 1);
    assert.equal(
      await scheduleCalendarLookup(
        calendar.runId,
        "not_found",
        "Event not found",
        retryTime,
        db,
      ),
      true,
    );
    assert.equal(
      (
        await getRunDetail(calendar.runId, db)
      )?.steps[1].nextAttemptAt?.toISOString(),
      "2026-10-10T12:02:00.000Z",
    );
    await markCalendarUncertain(
      calendar.runId,
      "calendar_unresolved",
      "Calendar outcome could not be confirmed",
      db,
    );
    assert.equal((await getRunDetail(calendar.runId, db))?.state, "failed");

    const found = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(found.runId, db);
    const foundId = await startCalendar(found.runId, db);
    await scheduleCalendarRetry(found.runId, "rate", "Rate limited", now, db);
    await claimNextRun(db, retryTime);
    await finishCalendarSucceeded(found.runId, foundId, db);
    const confirmed = await getRunDetail(found.runId, db);
    assert.equal(confirmed?.steps[1].state, "succeeded");
    assert.equal(confirmed?.steps[1].externalId, foundId);
    assert.equal(confirmed?.steps[1].nextAttemptAt, null);
    assert.equal(confirmed?.steps[1].error, null);
  });
});

test("worker advisory lock excludes another cycle and releases after work", async () => {
  await withSchema(async (db) => {
    let secondRan = false;
    const first = await withWorkerLock(db, async (assertActive) => {
      await assertActive();
      const second = await withWorkerLock(db, async () => {
        secondRan = true;
      });
      assert.equal(second, null);
      return "done";
    });
    assert.equal(first, "done");
    assert.equal(secondRan, false);
    assert.equal(await withWorkerLock(db, async () => "again"), "again");
  });
});

test("Calendar lookup scheduling stops after three read-only attempts", async () => {
  await withSchema(async (db) => {
    const { runId } = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    await startCalendar(runId, db);
    const times = [
      new Date("2026-10-10T12:00:00Z"),
      new Date("2026-10-10T12:01:00Z"),
      new Date("2026-10-10T12:06:00Z"),
    ];
    for (const [index, at] of times.entries()) {
      assert.equal(await startCalendarLookup(runId, at, db), index + 1);
      assert.equal(
        await scheduleCalendarLookup(
          runId,
          "calendar_not_found",
          "Calendar event not found",
          at,
          db,
        ),
        index < 2,
      );
    }
    assert.equal((await getRunDetail(runId, db))?.steps[1].state, "running");
    await markCalendarUncertain(
      runId,
      "calendar_unresolved",
      "Calendar outcome could not be confirmed",
      db,
    );
    const count = await db.query<{ lookup_attempt_count: number }>(
      "SELECT lookup_attempt_count FROM step_run WHERE run_id = $1 AND step_name = 'calendar'",
      [runId],
    );
    assert.equal(count.rows[0].lookup_attempt_count, 3);
    assert.deepEqual(
      (await getRunDetail(runId, db))?.steps.map((step) => step.state),
      ["succeeded", "uncertain", "skipped"],
    );
  });
});

test("failed run success commit rolls back Gmail success and preserves uncertain boundary", async () => {
  await withSchema(async (db) => {
    const { runId } = await fixtureRun(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    await finishCalendarSucceeded(runId, eventId, db);
    await startGmail(runId, db);
    await db.query(`CREATE FUNCTION fail_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'succeeded' THEN RAISE EXCEPTION 'injected failure'; END IF;
      RETURN NEW; END $$`);
    await db.query(
      "CREATE TRIGGER fail_run_success BEFORE UPDATE ON run FOR EACH ROW EXECUTE FUNCTION fail_run_success()",
    );
    await assert.rejects(
      finishGmailSucceeded(runId, "message-id", db),
      /injected failure/,
    );
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "running");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].state, "running");
    assert.equal(detail?.steps[2].externalId, null);
  });
});

test("lost advisory-lock connection stops the current cycle", async () => {
  await withSchema(async (db) => {
    await assert.rejects(
      withWorkerLock(db, async (assertActive) => {
        const lock = await db.query<{ pid: number }>(
          "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 48274 AND objid = 4 AND granted",
        );
        assert.equal(lock.rowCount, 1);
        await db.query("SELECT pg_terminate_backend($1)", [lock.rows[0].pid]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await assertActive();
      }),
      /Worker lock connection lost/,
    );
    assert.equal(
      await withWorkerLock(db, async () => "recovered"),
      "recovered",
    );
  });
});
