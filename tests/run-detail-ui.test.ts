import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Pool } from "pg";
import RunList from "../src/app/runs/run-list";
import type { Run } from "../src/lib/runs";

test("an empty run list explains that no responses were detected", () => {
  const html = renderToStaticMarkup(RunList({ runs: [] }));
  assert.match(html, /No responses detected yet/);
});

test("each listed run links to its detail without showing answers", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const run: Run = {
    id,
    workflowId: "22222222-2222-4222-8222-222222222222",
    responseId: "response-1",
    createTime: new Date("2026-10-10T12:00:00.000Z"),
    lastSubmittedTime: new Date("2026-10-10T12:01:00.000Z"),
    answers: { text: "PRIVATE_ANSWER_SENTINEL" },
    configSnapshot: null,
    state: "queued",
    createdAt: new Date("2026-10-10T12:02:00.000Z"),
  };
  const html = renderToStaticMarkup(RunList({ runs: [run] }));
  assert.match(html, /href="\/runs\/11111111-1111-4111-8111-111111111111"/);
  assert.doesNotMatch(html, /PRIVATE_ANSWER_SENTINEL/);
});

test("run list shows readable terminal states", () => {
  const run: Run = {
    id: "11111111-1111-4111-8111-111111111111",
    workflowId: "22222222-2222-4222-8222-222222222222",
    responseId: "response-1",
    createTime: new Date("2026-10-10T12:00:00.000Z"),
    lastSubmittedTime: new Date("2026-10-10T12:01:00.000Z"),
    answers: {},
    configSnapshot: null,
    state: "partially_failed",
    createdAt: new Date("2026-10-10T12:02:00.000Z"),
  };
  assert.match(
    renderToStaticMarkup(RunList({ runs: [run] })),
    /State: Partially failed/,
  );
});

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const admin = new Pool({ connectionString });
const schema = `m03_ui_${randomUUID().replaceAll("-", "")}`;
let db: Pool;

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { getDb } = await import("../src/lib/db");
  db = getDb();
  for (const migration of [
    "001_init",
    "002_workflow_config",
    "003_run_execution",
    "004_recovery",
    "005_gmail_uncertainty",
  ]) {
    await db.query(await readFile(`db/${migration}.sql`, "utf8"));
  }
});

after(async () => {
  if (db) await db.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

async function fixtureRun(state = "queued", detectionOnly = false) {
  const workflow = await db.query<{ id: string }>(
    "INSERT INTO workflow (name, form_id) VALUES ('Run UI', $1) RETURNING id",
    [`form-${randomUUID()}`],
  );
  const run = await db.query<{ id: string }>(
    `INSERT INTO run (workflow_id, response_id, create_time, last_submitted_time,
                      answers_json, config_snapshot, state)
     VALUES ($1, $2, $3, $3, $4::jsonb, $5::jsonb, $6) RETURNING id`,
    [
      workflow.rows[0].id,
      `response-${randomUUID()}`,
      "2026-10-10T12:01:00.000Z",
      JSON.stringify({ answer: "PRIVATE_ANSWER_SENTINEL" }),
      detectionOnly
        ? null
        : JSON.stringify({ emailBody: "PRIVATE_EMAIL_BODY_SENTINEL" }),
      state,
    ],
  );
  return run.rows[0].id;
}

async function step(
  runId: string,
  name: "filter" | "calendar" | "gmail",
  state: string,
  fields: {
    summary?: string;
    externalId?: string;
    errorCode?: string;
    errorMessage?: string;
    attemptCount?: number;
    nextAttemptAt?: string;
    uncertainSendSeen?: boolean;
  } = {},
) {
  await db.query(
    `INSERT INTO step_run (run_id, step_name, state, attempt_count, started_at,
                           finished_at, result_summary, external_id, error_code, error_message,
                           next_attempt_at, uncertain_send_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      runId,
      name,
      state,
      fields.attemptCount ?? 0,
      state === "pending" || state === "skipped"
        ? null
        : "2026-10-10T12:02:00.000Z",
      ["pending", "running"].includes(state)
        ? null
        : "2026-10-10T12:03:00.000Z",
      fields.summary ?? null,
      fields.externalId ?? null,
      fields.errorCode ?? null,
      fields.errorMessage ?? null,
      fields.nextAttemptAt ?? null,
      fields.uncertainSendSeen ?? false,
    ],
  );
}

async function detailHtml(id: string, retry?: string) {
  const { default: RunDetailPage } = await import("../src/app/runs/[id]/page");
  return renderToStaticMarkup(
    await RunDetailPage({
      params: Promise.resolve({ id }),
      searchParams: retry ? Promise.resolve({ retry }) : undefined,
    }),
  );
}

test("a missing run opens the 404 page", async () => {
  const { default: RunDetailPage } = await import("../src/app/runs/[id]/page");
  await assert.rejects(
    RunDetailPage({ params: Promise.resolve({ id: randomUUID() }) }),
    /NEXT_HTTP_ERROR_FALLBACK;404/,
  );
});

test("a malformed run ID opens the 404 page", async () => {
  const { default: RunDetailPage } = await import("../src/app/runs/[id]/page");
  await assert.rejects(
    RunDetailPage({ params: Promise.resolve({ id: "not-a-uuid" }) }),
    /NEXT_HTTP_ERROR_FALLBACK;404/,
  );
});

test("a queued snapshot run shows three ordered pending steps without private inputs", async () => {
  const id = await fixtureRun();
  const html = await detailHtml(id);
  assert.match(html, /Queued/);
  assert.match(html, /2026-10-10T12:01:00.000Z/);
  assert.match(html, /Filter[\s\S]*Calendar[\s\S]*Gmail/);
  assert.equal((html.match(/Pending/g) ?? []).length, 3);
  assert.doesNotMatch(
    html,
    /PRIVATE_ANSWER_SENTINEL|PRIVATE_EMAIL_BODY_SENTINEL/,
  );
});

test("a legacy run shows detection history even if step rows exist", async () => {
  const id = await fixtureRun("queued", true);
  await step(id, "calendar", "succeeded", { externalId: "should-be-hidden" });
  const html = await detailHtml(id);
  assert.match(html, /Detection history/);
  assert.doesNotMatch(html, /Filter|Calendar|Gmail|should-be-hidden/);
});

test("a filtered run shows skipped actions and no result IDs", async () => {
  const id = await fixtureRun("filtered_out");
  await step(id, "filter", "succeeded", {
    summary: "Filter did not match",
    attemptCount: 1,
  });
  await step(id, "calendar", "skipped");
  await step(id, "gmail", "skipped");
  const html = await detailHtml(id);
  assert.match(html, /Filtered out/);
  assert.match(html, /Filter did not match/);
  assert.equal((html.match(/Skipped/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Event ID|Message ID|Planned ID/);
});

test("a successful run shows confirmed action IDs and qualified Gmail wording", async () => {
  const id = await fixtureRun("succeeded");
  await step(id, "filter", "succeeded", {
    summary: "Filter matched",
    attemptCount: 1,
  });
  await step(id, "calendar", "succeeded", {
    summary: "Calendar event created",
    externalId: "event-confirmed",
    attemptCount: 1,
  });
  await step(id, "gmail", "succeeded", {
    summary: "Gmail accepted message",
    externalId: "message-confirmed",
    attemptCount: 1,
  });
  const html = await detailHtml(id);
  assert.match(html, /Event ID:[\s\S]*event-confirmed/);
  assert.match(html, /Message ID:[\s\S]*message-confirmed/);
  assert.match(html, /Accepted for sending, not delivered/);
  assert.match(html, /2026-10-10T12:02:00.000Z/);
  assert.match(html, /2026-10-10T12:03:00.000Z/);
  assert.doesNotMatch(
    html,
    /PRIVATE_ANSWER_SENTINEL|PRIVATE_EMAIL_BODY_SENTINEL/,
  );
});

test("a pre-action failure shows its run error and skipped actions", async () => {
  const id = await fixtureRun("failed");
  await db.query(
    "UPDATE run SET error_code = $2, error_message = $3 WHERE id = $1",
    [id, "invalid_response", "Required response is invalid"],
  );
  await step(id, "filter", "succeeded", {
    summary: "Filter matched",
    attemptCount: 1,
  });
  await step(id, "calendar", "skipped");
  await step(id, "gmail", "skipped");
  const html = await detailHtml(id);
  assert.match(html, /invalid_response/);
  assert.match(html, /Required response is invalid/);
  assert.equal((html.match(/Skipped/g) ?? []).length, 2);
});

test("a Calendar failure shows its safe step error and skipped Gmail", async () => {
  const id = await fixtureRun("failed");
  await step(id, "filter", "succeeded", {
    summary: "Filter matched",
    attemptCount: 1,
  });
  await step(id, "calendar", "failed", {
    errorCode: "calendar_rejected",
    errorMessage: "Calendar rejected event",
    attemptCount: 1,
  });
  await step(id, "gmail", "skipped");
  const html = await detailHtml(id);
  assert.match(html, /calendar_rejected/);
  assert.match(html, /Calendar rejected event/);
  assert.match(html, /Gmail[\s\S]*Skipped/);
});

test("a definite Gmail failure retains the event and offers Gmail-only retry", async () => {
  const id = await fixtureRun("partially_failed");
  await step(id, "filter", "succeeded", {
    summary: "Filter matched",
    attemptCount: 1,
  });
  await step(id, "calendar", "succeeded", {
    externalId: "retained-event",
    attemptCount: 1,
  });
  await step(id, "gmail", "failed", {
    errorCode: "gmail_rejected",
    errorMessage: "Gmail rejected message",
    attemptCount: 1,
  });
  const html = await detailHtml(id);
  assert.match(html, /Partially failed/);
  assert.match(html, /Event ID:[\s\S]*retained-event/);
  assert.match(html, /gmail_rejected/);
  assert.match(html, /Calendar event retained/);
  assert.match(html, /Gmail step failed/);
  assert.match(html, /Retry Gmail only/);
  assert.doesNotMatch(html, /duplicate email|type="checkbox"/i);
});

test("an uncertain Gmail send requires an unchecked duplicate-risk acknowledgment", async () => {
  const id = await fixtureRun("partially_failed");
  await step(id, "calendar", "succeeded", { externalId: "retained-event" });
  await step(id, "gmail", "uncertain", {
    errorCode: "gmail_outcome_unknown",
    errorMessage: "Message may have been sent",
    uncertainSendSeen: true,
  });
  const html = await detailHtml(id);
  assert.match(html, /Send outcome uncertain/);
  assert.match(html, /duplicate email/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /Retry Gmail, possibly sending a duplicate/);
  assert.match(html, /Calendar event retained/);
});

test("earlier uncertainty still requires warning after a later definite failure", async () => {
  const id = await fixtureRun("partially_failed");
  await step(id, "calendar", "succeeded", { externalId: "retained-event" });
  await step(id, "gmail", "failed", { uncertainSendSeen: true });
  assert.match(await detailHtml(id), /duplicate email/);
});

test("a scheduled retry shows its due time", async () => {
  const id = await fixtureRun();
  await step(id, "filter", "succeeded");
  await step(id, "calendar", "pending", {
    nextAttemptAt: "2026-10-10T12:10:00.000Z",
    attemptCount: 1,
  });
  await step(id, "gmail", "pending");
  const html = await detailHtml(id);
  assert.match(html, /Retry scheduled/);
  assert.match(html, /2026-10-10T12:10:00.000Z/);
});

test("a disabled workflow shows queued Gmail retry as paused", async () => {
  const id = await fixtureRun();
  await db.query(
    "UPDATE workflow SET enabled = false WHERE id = (SELECT workflow_id FROM run WHERE id = $1)",
    [id],
  );
  await step(id, "calendar", "succeeded", { externalId: "retained-event" });
  await step(id, "gmail", "pending");
  const html = await detailHtml(id);
  assert.match(html, /Paused while workflow is disabled/);
  assert.doesNotMatch(html, /Retry Gmail only|duplicate email/);
});

test("an unresolved Calendar outcome has no action form", async () => {
  const id = await fixtureRun("failed");
  await step(id, "calendar", "uncertain", { externalId: "reserved-event" });
  await step(id, "gmail", "skipped");
  const html = await detailHtml(id);
  assert.match(html, /Calendar outcome unresolved/);
  assert.doesNotMatch(html, /<form|Retry Gmail/);
});

test("retry result shows queued and running states and safe rejection", async () => {
  const queuedId = await fixtureRun();
  const forged = await detailHtml(queuedId, "queued");
  assert.doesNotMatch(
    forged,
    /Gmail-only retry queued|Gmail step queued|Gmail step running/,
  );

  const retryId = await fixtureRun();
  await step(retryId, "calendar", "succeeded", {
    externalId: "retained-event",
  });
  await step(retryId, "gmail", "pending");
  const queued = await detailHtml(retryId, "queued");
  assert.match(queued, /Gmail step queued/);

  const runningId = await fixtureRun("running");
  await step(runningId, "calendar", "succeeded", {
    externalId: "retained-event",
  });
  await step(runningId, "gmail", "running", { attemptCount: 2 });
  const running = await detailHtml(runningId, "queued");
  assert.match(running, /Gmail step running/);

  const initialRunningId = await fixtureRun("running");
  await step(initialRunningId, "calendar", "running", {
    externalId: "reserved-event",
  });
  const initialRunning = await detailHtml(initialRunningId, "queued");
  assert.doesNotMatch(initialRunning, /Gmail step running/);

  const initialGmailId = await fixtureRun("running");
  await step(initialGmailId, "calendar", "succeeded", {
    externalId: "confirmed-event",
  });
  await step(initialGmailId, "gmail", "running", { attemptCount: 1 });
  assert.doesNotMatch(
    await detailHtml(initialGmailId, "queued"),
    /Gmail step running/,
  );

  const rejected = await detailHtml(queuedId, "not_allowed");
  assert.match(rejected, /Gmail retry was not queued/);
  assert.doesNotMatch(
    rejected,
    /PRIVATE_ANSWER_SENTINEL|PRIVATE_EMAIL_BODY_SENTINEL/,
  );
});

test("Gmail retry action requires acknowledgment and rejects repeated posts", async () => {
  const id = await fixtureRun("partially_failed");
  await step(id, "calendar", "succeeded", { externalId: "retained-event" });
  await step(id, "gmail", "uncertain", { uncertainSendSeen: true });
  const { retryGmailAction } = await import("../src/app/runs/[id]/actions");
  const redirectedTo = (suffix: string) => (error: unknown) =>
    error instanceof Error &&
    "digest" in error &&
    String(error.digest).includes(suffix);
  await assert.rejects(
    retryGmailAction(id, new FormData()),
    redirectedTo("retry=warning_required"),
  );
  const invalid = new FormData();
  invalid.set("acknowledgeDuplicateRisk", "true");
  await assert.rejects(
    retryGmailAction(id, invalid),
    redirectedTo("retry=warning_required"),
  );
  const duplicated = new FormData();
  duplicated.append("acknowledgeDuplicateRisk", "yes");
  duplicated.append("acknowledgeDuplicateRisk", "yes");
  await assert.rejects(
    retryGmailAction(id, duplicated),
    redirectedTo("retry=warning_required"),
  );
  const pending = await db.query(
    "SELECT state FROM step_run WHERE run_id = $1 AND step_name = 'gmail'",
    [id],
  );
  assert.equal(pending.rows[0].state, "uncertain");
  const confirmed = new FormData();
  confirmed.set("acknowledgeDuplicateRisk", "yes");
  await assert.rejects(
    retryGmailAction(id, confirmed),
    redirectedTo("retry=queued"),
  );
  await assert.rejects(
    retryGmailAction(id, confirmed),
    redirectedTo("retry=not_allowed"),
  );
  const result = await db.query(
    "SELECT state, retry_mode FROM step_run WHERE run_id = $1 AND step_name = 'gmail'",
    [id],
  );
  assert.deepEqual(result.rows[0], { state: "pending", retry_mode: "manual" });
});

test("a definite Gmail rejection can be queued without an acknowledgment", async () => {
  const id = await fixtureRun("partially_failed");
  await step(id, "calendar", "succeeded", { externalId: "retained-event" });
  await step(id, "gmail", "failed");
  const { retryGmailAction } = await import("../src/app/runs/[id]/actions");
  await assert.rejects(
    retryGmailAction(id, new FormData()),
    (error: unknown) =>
      error instanceof Error &&
      "digest" in error &&
      String(error.digest).includes("retry=queued"),
  );
  const result = await db.query(
    "SELECT state FROM step_run WHERE run_id = $1 AND step_name = 'gmail'",
    [id],
  );
  assert.equal(result.rows[0].state, "pending");
});

test("a running Calendar step labels its reserved ID as planned", async () => {
  const id = await fixtureRun("running");
  await step(id, "filter", "succeeded", {
    summary: "Filter matched",
    attemptCount: 1,
  });
  await step(id, "calendar", "running", {
    externalId: "reserved-event",
    attemptCount: 1,
  });
  await step(id, "gmail", "pending");
  const html = await detailHtml(id);
  assert.match(html, /Running/);
  assert.match(html, /Planned ID:[\s\S]*reserved-event/);
  assert.doesNotMatch(html, /Event ID:[\s\S]*reserved-event/);
});
