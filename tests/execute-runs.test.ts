import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  claimNextRun,
  markFilterMatched,
  startCalendar,
  finishCalendarSucceeded,
  startGmail,
  getRunDetail,
  type CalendarClient,
  type CalendarLookupClient,
  type GmailClient,
} from "../src/lib/run-execution";
import {
  executeClaimedRun,
  executePendingRuns,
} from "../src/worker/execute-runs";
import { config } from "./workflow-fixtures";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const admin = new Pool({ connectionString });
after(() => admin.end());

async function withSchema(body: (db: Pool) => Promise<void>) {
  const schema = `m03_exec_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString!);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = new Pool({ connectionString: url.toString() });
  try {
    for (const file of [
      "001_init",
      "002_workflow_config",
      "003_run_execution",
      "004_recovery",
      "005_gmail_uncertainty",
    ]) {
      await db.query(await readFile(`db/${file}.sql`, "utf8"));
    }
    await body(db);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

function answer(value: string) {
  return { textAnswers: { answers: [{ value }] } };
}

async function unexpectedLookup(): Promise<never> {
  throw new Error("Unexpected Calendar lookup");
}
function answers(overrides: Record<string, unknown> = {}) {
  return {
    name: answer("Alex Rivera"),
    email: answer("alex@example.com"),
    request: answer("Consultation"),
    date: answer("2026-10-15"),
    time: answer("10:00"),
    notes: answer("Test note"),
    ...overrides,
  };
}

async function queued(
  db: Pool,
  options: {
    enabled?: boolean;
    legacy?: boolean;
    answers?: Record<string, unknown>;
  } = {},
) {
  const workflow = await db.query<{ id: string }>(
    "INSERT INTO workflow (name, form_id, enabled, enabled_at, config_json) VALUES ('Test', 'form-1', $1, now(), $2::jsonb) RETURNING id",
    [
      options.enabled ?? true,
      JSON.stringify({ ...config, calendarId: "primary" }),
    ],
  );
  const workflowId = workflow.rows[0].id;
  await db.query("INSERT INTO form_poll_state (workflow_id) VALUES ($1)", [
    workflowId,
  ]);
  const run = await db.query<{ id: string }>(
    "INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time, answers_json, config_snapshot) VALUES ($1, $2, now(), now(), $3::jsonb, $4::jsonb) RETURNING id",
    [
      workflowId,
      randomUUID(),
      JSON.stringify(options.answers ?? answers()),
      options.legacy
        ? null
        : JSON.stringify({
            formId: "form-1",
            config: { ...config, calendarId: "primary" },
          }),
    ],
  );
  return { workflowId, runId: run.rows[0].id };
}

test("matching run commits each boundary and calls Calendar before Gmail once", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    const calls: string[] = [];
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        calls.push("calendar");
        const detail = await getRunDetail(runId, db);
        assert.deepEqual(
          detail?.steps.map((step) => step.state),
          ["succeeded", "running", "pending"],
        );
        assert.equal(detail?.steps[1].externalId, input.eventId);
        assert.equal(input.calendarId, "primary");
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage(input) {
        calls.push("gmail");
        const detail = await getRunDetail(runId, db);
        assert.deepEqual(
          detail?.steps.map((step) => step.state),
          ["succeeded", "succeeded", "running"],
        );
        assert.equal(input.to, "alex@example.com");
        return { ok: true, value: { messageId: "message-1" } };
      },
    };
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      1,
    );
    assert.deepEqual(calls, ["calendar", "gmail"]);
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "succeeded");
    assert.equal(detail?.steps[1].externalId, `a${runId.replaceAll("-", "")}`);
    assert.equal(detail?.steps[2].externalId, "message-1");
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      0,
    );
    assert.deepEqual(calls, ["calendar", "gmail"]);
  });
});

test("nonqualifying, invalid, disabled, and legacy runs call neither action", async () => {
  await withSchema(async (db) => {
    const filtered = await queued(db, {
      answers: answers({ request: answer("Other") }),
    });
    const invalid = await queued(db, {
      answers: answers({ name: answer("") }),
    });
    const disabled = await queued(db, { enabled: false });
    const legacy = await queued(db, { legacy: true });
    let calls = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent() {
        calls++;
        throw new Error("Unexpected Calendar call");
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        calls++;
        throw new Error("Unexpected Gmail call");
      },
    };
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      2,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await getRunDetail(filtered.runId, db))?.state,
      "filtered_out",
    );
    assert.equal((await getRunDetail(invalid.runId, db))?.state, "failed");
    assert.equal((await getRunDetail(disabled.runId, db))?.state, "queued");
    assert.equal((await getRunDetail(legacy.runId, db))?.detectionOnly, true);
  });
});

test("an invalid sender fails a matched run before Calendar", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent() {
        throw new Error("Unexpected Calendar call");
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Unexpected Gmail call");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "invalid sender");
    assert.equal((await getRunDetail(runId, db))?.state, "failed");
  });
});

test("definite Calendar rejection stops Gmail and definite Gmail rejection retains event", async () => {
  await withSchema(async (db) => {
    const calendarFailure = await queued(db);
    const partial = await queued(db);
    let gmailCalls = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        return input.eventId === `a${calendarFailure.runId.replaceAll("-", "")}`
          ? {
              ok: false,
              certainty: "rejected",
              code: "calendar_rejected",
              message: "Google Calendar rejected the event request",
            }
          : { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        gmailCalls++;
        return {
          ok: false,
          certainty: "rejected",
          code: "gmail_rejected",
          message: "Gmail rejected the message",
        };
      },
    };
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      2,
    );
    assert.equal(
      (await getRunDetail(calendarFailure.runId, db))?.state,
      "failed",
    );
    assert.equal(
      (await getRunDetail(calendarFailure.runId, db))?.steps[2].state,
      "skipped",
    );
    const detail = await getRunDetail(partial.runId, db);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].state, "succeeded");
    assert.equal(
      detail?.steps[1].externalId,
      `a${partial.runId.replaceAll("-", "")}`,
    );
    assert.equal(detail?.steps[2].state, "failed");
    assert.equal(gmailCalls, 1);
  });
});

test("unknown Calendar outcome starts read-only reconciliation without another insert", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let calendarCalls = 0;
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async lookupEvent() {
        lookups++;
        return { kind: "not_found" };
      },
      async insertEvent() {
        calendarCalls++;
        return {
          ok: false,
          certainty: "unknown",
          code: "calendar_unknown",
          message: "Calendar outcome unknown",
        };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Unexpected Gmail call");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal((await getRunDetail(runId, db))?.steps[1].state, "running");
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      0,
    );
    assert.equal(calendarCalls, 1);
    assert.equal(lookups, 1);
    assert.ok((await getRunDetail(runId, db))?.steps[1].nextAttemptAt);
  });
});

test("unknown Gmail outcome retains confirmed Calendar ID and is not resent", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let calendarCalls = 0;
    let gmailCalls = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        calendarCalls++;
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        gmailCalls++;
        return {
          ok: false,
          certainty: "unknown",
          code: "gmail_send_unknown",
          message: "Gmail send outcome could not be confirmed",
        };
      },
    };
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      1,
    );
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].state, "succeeded");
    assert.equal(detail?.steps[1].externalId, `a${runId.replaceAll("-", "")}`);
    assert.equal(detail?.steps[2].state, "uncertain");
    assert.equal(
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      0,
    );
    assert.equal(calendarCalls, 1);
    assert.equal(gmailCalls, 1);
  });
});

test("a run claimed before disable finishes from its snapshot", async () => {
  await withSchema(async (db) => {
    const { runId, workflowId } = await queued(db);
    const claim = await claimNextRun(db);
    assert.equal(claim?.id, runId);
    await db.query(
      "UPDATE workflow SET enabled = false, config_json = NULL WHERE id = $1",
      [workflowId],
    );
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        return { ok: true, value: { messageId: "message-2" } };
      },
    };
    await executeClaimedRun(
      claim!,
      calendar,
      gmail,
      db,
      () => "owner@example.com",
    );
    assert.equal((await getRunDetail(runId, db))?.state, "succeeded");
  });
});

test("restart resumes a claimed run and a confirmed Calendar without replay", async () => {
  await withSchema(async (db) => {
    const claimed = await queued(db);
    await claimNextRun(db);
    const confirmed = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(confirmed.runId, db);
    const eventId = await startCalendar(confirmed.runId, db);
    await finishCalendarSucceeded(confirmed.runId, eventId, db);
    const calls: string[] = [];
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        calls.push(`calendar:${input.eventId}`);
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        calls.push("gmail");
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.deepEqual(calls, [
      `calendar:a${claimed.runId.replaceAll("-", "")}`,
      "gmail",
      "gmail",
    ]);
    assert.equal((await getRunDetail(claimed.runId, db))?.state, "succeeded");
    const saved = await getRunDetail(confirmed.runId, db);
    assert.equal(saved?.state, "succeeded");
    assert.equal(saved?.steps[1].externalId, eventId);
    assert.equal(saved?.steps[1].attemptCount, 1);
  });
});

test("restart reconciles a started Calendar insert before any repeat action", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    let inserts = 0;
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        inserts++;
        throw new Error("Calendar insert must not replay");
      },
      async lookupEvent(input) {
        lookups++;
        assert.equal(input.eventId, eventId);
        return { kind: "found_match", eventId };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal(inserts, 0);
    assert.equal(lookups, 1);
    assert.equal((await getRunDetail(runId, db))?.state, "succeeded");
  });
});

test("unknown Calendar not-found is read-only and stops after three lookups", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    await startCalendar(runId, db);
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        throw new Error("Calendar insert must not replay");
      },
      async lookupEvent() {
        lookups++;
        return { kind: "not_found" };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Gmail must not send");
      },
    };
    for (const at of [
      "2026-10-10T12:00:00Z",
      "2026-10-10T12:00:59Z",
      "2026-10-10T12:01:00Z",
      "2026-10-10T12:06:00Z",
    ]) {
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
        now: () => new Date(at),
      });
    }
    const detail = await getRunDetail(runId, db);
    assert.equal(lookups, 3);
    assert.equal(detail?.state, "failed");
    assert.deepEqual(
      detail?.steps.map((step) => step.state),
      ["succeeded", "uncertain", "skipped"],
    );
    assert.equal(detail?.steps[1].attemptCount, 1);
  });
});

test("definite Calendar rate rejection retries by same ID only after lookup and backoff", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    const ids: string[] = [];
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent(input) {
        ids.push(input.eventId);
        return ids.length === 1
          ? {
              ok: false,
              certainty: "rejected",
              retryable: true,
              code: "calendar_rate_limited",
              message: "Calendar rate limited the request",
            }
          : { ok: true, value: { eventId: input.eventId } };
      },
      async lookupEvent() {
        return { kind: "not_found" };
      },
    };
    let sends = 0;
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return { ok: true, value: { messageId: "message" } };
      },
    };
    const t0 = new Date("2026-10-10T12:00:00Z");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => t0,
    });
    assert.equal((await getRunDetail(runId, db))?.state, "queued");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => new Date("2026-10-10T12:00:59Z"),
    });
    assert.equal(ids.length, 1);
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => new Date("2026-10-10T12:01:00Z"),
    });
    assert.deepEqual(ids, [ids[0], ids[0]]);
    assert.equal(sends, 1);
    assert.equal((await getRunDetail(runId, db))?.state, "succeeded");
  });
});

test("restart marks a started Gmail send uncertain without another send", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    await finishCalendarSucceeded(runId, eventId, db);
    await startGmail(runId, db);
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent() {
        throw new Error("Calendar must not replay");
      },
    };
    let sends = 0;
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        throw new Error("Gmail must not replay");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    const detail = await getRunDetail(runId, db);
    assert.equal(sends, 0);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].state, "uncertain");
  });
});

test("lost worker lock after Calendar success prevents a Gmail call and resumes later", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let sends = 0;
    let checks = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        inserts++;
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await assert.rejects(
      executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
        async assertActive() {
          checks++;
          if (checks === 2) throw new Error("Worker lock connection lost");
        },
      }),
      /Worker lock connection lost/,
    );
    const paused = await getRunDetail(runId, db);
    assert.equal(paused?.steps[1].state, "succeeded");
    assert.equal(paused?.steps[2].state, "pending");
    assert.equal(sends, 0);
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal(inserts, 1);
    assert.equal(sends, 1);
    assert.equal((await getRunDetail(runId, db))?.state, "succeeded");
  });
});

test("Gmail success with failed database commit becomes uncertain after restart", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let sends = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await db.query(`CREATE FUNCTION fail_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'succeeded' THEN RAISE EXCEPTION 'injected failure'; END IF;
      RETURN NEW; END $$`);
    await db.query(
      "CREATE TRIGGER fail_run_success BEFORE UPDATE ON run FOR EACH ROW EXECUTE FUNCTION fail_run_success()",
    );
    await assert.rejects(
      executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      /injected failure/,
    );
    await db.query("DROP TRIGGER fail_run_success ON run");
    assert.equal((await getRunDetail(runId, db))?.steps[2].state, "running");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[2].state, "uncertain");
    assert.equal(sends, 1);
  });
});

test("unavailable lookup blocks a due Calendar repeat insert", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        inserts++;
        return {
          ok: false,
          certainty: "rejected",
          retryable: true,
          code: "rate",
          message: "Rate limited",
        };
      },
      async lookupEvent() {
        lookups++;
        return {
          kind: "unavailable",
          code: "lookup_unavailable",
          message: "Lookup unavailable",
          retryable: true,
        };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Gmail must not send");
      },
    };
    for (const at of [
      "2026-10-10T12:00:00Z",
      "2026-10-10T12:01:00Z",
      "2026-10-10T12:02:00Z",
      "2026-10-10T12:07:00Z",
    ]) {
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
        now: () => new Date(at),
      });
    }
    const detail = await getRunDetail(runId, db);
    assert.equal(inserts, 1);
    assert.equal(lookups, 3);
    assert.equal(detail?.state, "failed");
    assert.equal(detail?.steps[1].state, "uncertain");
  });
});

test("restart stops an exhausted Calendar lookup boundary without another API call", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    await startCalendar(runId, db);
    await db.query(
      "UPDATE step_run SET lookup_attempt_count = 3 WHERE run_id = $1 AND step_name = 'calendar'",
      [runId],
    );
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        throw new Error("No insert expected");
      },
      async lookupEvent() {
        throw new Error("No lookup expected");
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("No send expected");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal((await getRunDetail(runId, db))?.state, "failed");
    assert.equal((await getRunDetail(runId, db))?.steps[1].state, "uncertain");
  });
});

test("Gmail rate retries stop after three automatic attempts without replaying Calendar", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let sends = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        inserts++;
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return {
          ok: false,
          certainty: "rejected",
          retryable: true,
          code: "rate",
          message: "Rate limited",
        };
      },
    };
    for (const at of [
      "2026-10-10T12:00:00Z",
      "2026-10-10T12:00:59Z",
      "2026-10-10T12:01:00Z",
      "2026-10-10T12:06:00Z",
    ]) {
      await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
        now: () => new Date(at),
      });
    }
    const detail = await getRunDetail(runId, db);
    assert.equal(inserts, 1);
    assert.equal(sends, 3);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[2].state, "failed");
    assert.equal(detail?.steps[2].attemptCount, 3);
  });
});

test("Calendar mismatch or permanent lookup failure stops without another insert", async () => {
  await withSchema(async (db) => {
    const mismatch = await queued(db);
    const denied = await queued(db);
    for (let index = 0; index < 2; index++) {
      const claim = await claimNextRun(db);
      assert.ok(claim);
      await markFilterMatched(claim.id, db);
      await startCalendar(claim.id, db);
    }
    let inserts = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        inserts++;
        throw new Error("No repeat insert expected");
      },
      async lookupEvent(input) {
        return input.eventId === `a${mismatch.runId.replaceAll("-", "")}`
          ? { kind: "found_mismatch" }
          : {
              kind: "unavailable",
              code: "calendar_denied",
              message: "Calendar lookup denied",
              retryable: false,
            };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("No Gmail send expected");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    for (const runId of [mismatch.runId, denied.runId]) {
      const detail = await getRunDetail(runId, db);
      assert.equal(detail?.state, "failed");
      assert.deepEqual(
        detail?.steps.map((step) => step.state),
        ["succeeded", "uncertain", "skipped"],
      );
    }
    assert.equal(inserts, 0);
  });
});

test("a running run recovers after disable while a queued run stays paused", async () => {
  await withSchema(async (db) => {
    const active = await queued(db);
    const paused = await queued(db, { enabled: false });
    await claimNextRun(db);
    await db.query("UPDATE workflow SET enabled = false WHERE id = $1", [
      active.workflowId,
    ]);
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal((await getRunDetail(active.runId, db))?.state, "succeeded");
    assert.equal((await getRunDetail(paused.runId, db))?.state, "queued");
  });
});

test("invalid sender after confirmed Calendar fails Gmail before any send", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    await finishCalendarSucceeded(runId, eventId, db);
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent() {
        throw new Error("Calendar must not replay");
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Gmail must not send");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "invalid sender");
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].state, "failed");
    assert.equal(detail?.steps[2].attemptCount, 0);
  });
});

test("invalid sender after Calendar start still reconciles and never sends", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const eventId = await startCalendar(runId, db);
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        throw new Error("Calendar must not replay");
      },
      async lookupEvent(input) {
        lookups++;
        assert.equal(input.eventId, eventId);
        return { kind: "found_match", eventId };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Gmail must not send");
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "invalid sender");
    const detail = await getRunDetail(runId, db);
    assert.equal(lookups, 1);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].state, "succeeded");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].state, "failed");
    assert.equal(detail?.steps[2].attemptCount, 0);
  });
});

test("invalid sender on a due Calendar retry stops after lookup without repeat insert", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent() {
        inserts++;
        return {
          ok: false,
          certainty: "rejected",
          retryable: true,
          code: "rate",
          message: "Rate limited",
        };
      },
      async lookupEvent() {
        lookups++;
        return { kind: "not_found" };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        throw new Error("Gmail must not send");
      },
    };
    const first = new Date("2026-10-10T12:00:00Z");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => first,
    });
    assert.equal((await getRunDetail(runId, db))?.state, "queued");
    await executePendingRuns(calendar, gmail, db, () => "invalid sender", {
      now: () => new Date("2026-10-10T12:01:00Z"),
    });
    const detail = await getRunDetail(runId, db);
    assert.equal(inserts, 1);
    assert.equal(lookups, 1);
    assert.equal(detail?.state, "failed");
    assert.deepEqual(
      detail?.steps.map((step) => step.state),
      ["succeeded", "failed", "skipped"],
    );
  });
});

test("Calendar success with failed database commit is found on restart", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let lookups = 0;
    let sends = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent(input) {
        inserts++;
        return { ok: true, value: { eventId: input.eventId } };
      },
      async lookupEvent(input) {
        lookups++;
        return { kind: "found_match", eventId: input.eventId };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await db.query(`CREATE FUNCTION fail_calendar_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.step_name = 'calendar' AND NEW.state = 'succeeded' THEN RAISE EXCEPTION 'injected failure'; END IF;
      RETURN NEW; END $$`);
    await db.query(
      "CREATE TRIGGER fail_calendar_commit BEFORE UPDATE ON step_run FOR EACH ROW EXECUTE FUNCTION fail_calendar_commit()",
    );
    await assert.rejects(
      executePendingRuns(calendar, gmail, db, () => "owner@example.com"),
      /injected failure/,
    );
    await db.query("DROP TRIGGER fail_calendar_commit ON step_run");
    assert.equal((await getRunDetail(runId, db))?.steps[1].state, "running");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    const detail = await getRunDetail(runId, db);
    assert.equal(inserts, 1);
    assert.equal(lookups, 1);
    assert.equal(sends, 1);
    assert.equal(detail?.state, "succeeded");
    assert.equal(detail?.steps[1].attemptCount, 1);
  });
});

test("restart after Filter commit executes actions without repeating Filter", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    await claimNextRun(db);
    await markFilterMatched(runId, db);
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        return { ok: true, value: { messageId: "message" } };
      },
    };
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    const detail = await getRunDetail(runId, db);
    assert.equal(detail?.state, "succeeded");
    assert.equal(detail?.steps[0].attemptCount, 1);
    assert.equal(detail?.steps[1].attemptCount, 1);
    assert.equal(detail?.steps[2].attemptCount, 1);
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com");
    assert.equal((await getRunDetail(runId, db))?.state, "succeeded");
  });
});

test("restart after claiming a due Calendar retry looks up before same-ID insert", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let lookups = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      async insertEvent(input) {
        inserts++;
        return inserts === 1
          ? {
              ok: false,
              certainty: "rejected",
              retryable: true,
              code: "rate",
              message: "Rate limited",
            }
          : { ok: true, value: { eventId: input.eventId } };
      },
      async lookupEvent() {
        lookups++;
        return { kind: "not_found" };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        return { ok: true, value: { messageId: "message" } };
      },
    };
    const first = new Date("2026-10-10T12:00:00Z");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => first,
    });
    const due = new Date("2026-10-10T12:01:00Z");
    assert.equal((await claimNextRun(db, due))?.id, runId);
    assert.equal((await getRunDetail(runId, db))?.steps[1].state, "pending");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => due,
    });
    const detail = await getRunDetail(runId, db);
    assert.equal(lookups, 1);
    assert.equal(inserts, 2);
    assert.equal(detail?.state, "succeeded");
    assert.equal(detail?.steps[1].attemptCount, 2);
  });
});

test("restart after a claimed manual Gmail request sends only Gmail once", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let inserts = 0;
    let sends = 0;
    const calendar: CalendarClient & CalendarLookupClient = {
      lookupEvent: unexpectedLookup,
      async insertEvent(input) {
        inserts++;
        return { ok: true, value: { eventId: input.eventId } };
      },
    };
    const gmail: GmailClient = {
      async sendMessage() {
        sends++;
        return {
          ok: false,
          certainty: "rejected",
          retryable: sends > 1,
          code: "rate",
          message: "Rate limited",
        };
      },
    };
    const first = new Date("2026-10-10T12:00:00Z");
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => first,
    });
    const eventId = (await getRunDetail(runId, db))?.steps[1].externalId;
    await db.query(
      `UPDATE step_run SET state = 'pending', retry_mode = 'manual', next_attempt_at = $2
       WHERE run_id = $1 AND step_name = 'gmail'`,
      [runId, first],
    );
    await db.query("UPDATE run SET state = 'queued' WHERE id = $1", [runId]);
    assert.equal((await claimNextRun(db, first))?.id, runId);
    await executePendingRuns(calendar, gmail, db, () => "owner@example.com", {
      now: () => first,
    });
    const detail = await getRunDetail(runId, db);
    assert.equal(inserts, 1);
    assert.equal(sends, 2);
    assert.equal(detail?.state, "partially_failed");
    assert.equal(detail?.steps[1].externalId, eventId);
    assert.equal(detail?.steps[2].attemptCount, 2);
  });
});
