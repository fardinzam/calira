import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  claimNextRun,
  getRunDetail,
  type CalendarClient,
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
    const calendar: CalendarClient = {
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
    const calendar: CalendarClient = {
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
    const calendar: CalendarClient = {
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
    const calendar: CalendarClient = {
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

test("unknown action outcome remains running and is never automatically reclaimed", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let calendarCalls = 0;
    const calendar: CalendarClient = {
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
  });
});

test("unknown Gmail outcome retains confirmed Calendar ID and is not resent", async () => {
  await withSchema(async (db) => {
    const { runId } = await queued(db);
    let calendarCalls = 0;
    let gmailCalls = 0;
    const calendar: CalendarClient = {
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
    assert.equal(detail?.state, "running");
    assert.equal(detail?.steps[1].state, "succeeded");
    assert.equal(detail?.steps[1].externalId, `a${runId.replaceAll("-", "")}`);
    assert.equal(detail?.steps[2].state, "running");
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
    const calendar: CalendarClient = {
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
