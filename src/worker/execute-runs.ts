import type { Pool } from "pg";
import { getDb } from "../lib/db";
import { getGoogleSenderEmail } from "../lib/google/auth";
import { evaluateFilter, prepareActions } from "../lib/response-mapping";
import {
  claimNextRun,
  finishCalendarRejected,
  finishCalendarSucceeded,
  finishGmailRejected,
  finishGmailSucceeded,
  getRunDetail,
  listRunningRuns,
  markCalendarUncertain,
  markFilterFailed,
  markFilteredOut,
  markFilterMatched,
  markGmailPreflightFailed,
  markGmailUncertain,
  markValidationFailed,
  scheduleCalendarLookup,
  scheduleCalendarRetry,
  scheduleGmailRetry,
  startCalendar,
  startCalendarLookup,
  startGmail,
  type CalendarClient,
  type CalendarEventInput,
  type CalendarLookupClient,
  type ClaimedRun,
  type GmailClient,
} from "../lib/run-execution";
import type { RunConfigSnapshot } from "../lib/workflow-config";

type RecoveryCalendar = CalendarClient & CalendarLookupClient;
type ExecutionOptions = {
  now?: () => Date;
  assertActive?: () => Promise<void>;
};

async function reconcileCalendar(
  runId: string,
  input: CalendarEventInput,
  priorOutcome: "rejected" | "unknown",
  calendar: RecoveryCalendar,
  db: Pool,
  now: Date,
  assertActive: () => Promise<void>,
): Promise<"confirmed" | "insert" | "stop"> {
  if ((await startCalendarLookup(runId, now, db)) === 0) {
    await markCalendarUncertain(
      runId,
      "calendar_unresolved",
      "Calendar event could not be confirmed",
      db,
    );
    return "stop";
  }
  await assertActive();
  let result: Awaited<ReturnType<CalendarLookupClient["lookupEvent"]>>;
  try {
    result = await calendar.lookupEvent(input);
  } catch {
    result = {
      kind: "unavailable",
      code: "calendar_lookup_unavailable",
      message: "Calendar event lookup could not be completed",
      retryable: true,
    };
  }
  if (result.kind === "found_match") {
    await finishCalendarSucceeded(runId, result.eventId, db);
    return "confirmed";
  }
  if (result.kind === "not_found" && priorOutcome === "rejected")
    return "insert";
  if (
    result.kind === "found_mismatch" ||
    (result.kind === "unavailable" && !result.retryable)
  ) {
    await markCalendarUncertain(
      runId,
      "calendar_unresolved",
      "Calendar event could not be confirmed",
      db,
    );
    return "stop";
  }
  const code = result.kind === "not_found" ? "calendar_not_found" : result.code;
  const message =
    result.kind === "not_found"
      ? "Calendar event was not found"
      : result.message;
  if (!(await scheduleCalendarLookup(runId, code, message, now, db))) {
    await markCalendarUncertain(
      runId,
      "calendar_unresolved",
      "Calendar event could not be confirmed",
      db,
    );
  }
  return "stop";
}

async function insertCalendar(
  claim: ClaimedRun,
  input: Omit<CalendarEventInput, "eventId">,
  calendar: RecoveryCalendar,
  db: Pool,
  now: () => Date,
  assertActive: () => Promise<void>,
): Promise<boolean> {
  const eventId = await startCalendar(claim.id, db);
  await assertActive();
  let result: Awaited<ReturnType<CalendarClient["insertEvent"]>>;
  try {
    result = await calendar.insertEvent({ ...input, eventId });
  } catch {
    return false;
  }
  if (!result.ok) {
    if (result.certainty === "rejected") {
      if (
        !result.retryable ||
        !(await scheduleCalendarRetry(
          claim.id,
          result.code,
          result.message,
          now(),
          db,
        ))
      ) {
        await finishCalendarRejected(claim.id, result.code, result.message, db);
      }
    }
    return false;
  }
  await finishCalendarSucceeded(claim.id, result.value.eventId, db);
  return true;
}

export async function executeClaimedRun(
  claim: ClaimedRun,
  calendar: RecoveryCalendar,
  gmail: GmailClient,
  db: Pool,
  sender: () => string = getGoogleSenderEmail,
  options: ExecutionOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const assertActive = options.assertActive ?? (async () => {});
  const snapshot = claim.snapshot as RunConfigSnapshot;
  const detail = await getRunDetail(claim.id, db);
  if (!detail || detail.state !== "running" || detail.detectionOnly) return;
  if (
    detail.steps.find((step) => step.name === "calendar")?.state ===
      "succeeded" &&
    detail.steps.find((step) => step.name === "gmail")?.state === "running"
  ) {
    await markGmailUncertain(claim.id, db);
    return;
  }
  const filter = detail.steps.find((step) => step.name === "filter");
  if (filter?.state === "pending") {
    let match: "matched" | "filtered_out";
    try {
      match = evaluateFilter(claim.answers, snapshot);
    } catch {
      await markFilterFailed(
        claim.id,
        "invalid_filter_input",
        "Saved configuration or Filter answer is invalid",
        db,
      );
      return;
    }
    if (match === "filtered_out") {
      await markFilteredOut(claim.id, db);
      return;
    }
  } else if (filter?.state !== "succeeded") {
    return;
  }

  let actions: ReturnType<typeof prepareActions>;
  let senderReady = true;
  try {
    actions = prepareActions(claim.answers, snapshot, sender());
  } catch {
    const calendarStep = detail.steps.find((step) => step.name === "calendar");
    if (
      calendarStep?.state === "running" ||
      (calendarStep?.state === "pending" && calendarStep.attemptCount > 0)
    ) {
      // A Calendar call may have happened. Recover its saved input without
      // using this placeholder for Gmail; the actual sender is checked below.
      try {
        actions = prepareActions(
          claim.answers,
          snapshot,
          "recovery@example.invalid",
        );
        senderReady = false;
      } catch {
        await markCalendarUncertain(
          claim.id,
          "calendar_unresolved",
          "Calendar event could not be confirmed",
          db,
        );
        return;
      }
    } else if (
      calendarStep?.state === "pending" &&
      calendarStep.attemptCount === 0
    ) {
      await markValidationFailed(
        claim.id,
        "invalid_action_input",
        "Required response values or sender address are invalid",
        db,
      );
      return;
    } else if (
      calendarStep?.state === "succeeded" &&
      detail.steps.find((step) => step.name === "gmail")?.state === "pending"
    ) {
      await markGmailPreflightFailed(
        claim.id,
        "invalid_action_input",
        "Required response values or sender address are invalid",
        db,
      );
      return;
    } else {
      return;
    }
  }
  if (filter.state === "pending") await markFilterMatched(claim.id, db);

  const calendarStep = detail.steps.find((step) => step.name === "calendar");
  if (!calendarStep) return;
  if (calendarStep.state === "pending" || calendarStep.state === "running") {
    if (calendarStep.nextAttemptAt && calendarStep.nextAttemptAt > now())
      return;
    if (calendarStep.state === "running" || calendarStep.attemptCount > 0) {
      const eventId = calendarStep.externalId;
      if (!eventId) {
        await markCalendarUncertain(
          claim.id,
          "calendar_unresolved",
          "Calendar event could not be confirmed",
          db,
        );
        return;
      }
      const status = await reconcileCalendar(
        claim.id,
        { ...actions.calendar, eventId },
        calendarStep.state === "running" ? "unknown" : "rejected",
        calendar,
        db,
        now(),
        assertActive,
      );
      if (status === "stop") return;
      if (status === "insert" && !senderReady) {
        await finishCalendarRejected(
          claim.id,
          "invalid_action_input",
          "Required response values or sender address are invalid",
          db,
        );
        return;
      }
      if (
        status === "insert" &&
        !(await insertCalendar(
          claim,
          actions.calendar,
          calendar,
          db,
          now,
          assertActive,
        ))
      )
        return;
    } else if (
      !(await insertCalendar(
        claim,
        actions.calendar,
        calendar,
        db,
        now,
        assertActive,
      ))
    ) {
      return;
    }
  } else if (calendarStep.state !== "succeeded") {
    return;
  }

  const refreshed = await getRunDetail(claim.id, db);
  const gmailStep = refreshed?.steps.find((step) => step.name === "gmail");
  if (gmailStep?.state === "running") {
    await markGmailUncertain(claim.id, db);
    return;
  }
  if (
    gmailStep?.state !== "pending" ||
    (gmailStep.nextAttemptAt && gmailStep.nextAttemptAt > now())
  )
    return;
  if (!senderReady) {
    await markGmailPreflightFailed(
      claim.id,
      "invalid_action_input",
      "Required response values or sender address are invalid",
      db,
    );
    return;
  }
  await assertActive();
  await startGmail(claim.id, db);
  await assertActive();
  let result: Awaited<ReturnType<GmailClient["sendMessage"]>>;
  try {
    result = await gmail.sendMessage(actions.gmail);
  } catch {
    await markGmailUncertain(claim.id, db);
    return;
  }
  if (!result.ok) {
    if (result.certainty === "unknown") {
      await markGmailUncertain(claim.id, db);
    } else if (
      !result.retryable ||
      !(await scheduleGmailRetry(
        claim.id,
        result.code,
        result.message,
        now(),
        db,
      ))
    ) {
      await finishGmailRejected(claim.id, result.code, result.message, db);
    }
    return;
  }
  await finishGmailSucceeded(claim.id, result.value.messageId, db);
}

export async function recoverRunningRuns(
  calendar: RecoveryCalendar,
  gmail: GmailClient,
  db: Pool = getDb(),
  sender: () => string = getGoogleSenderEmail,
  options: ExecutionOptions = {},
): Promise<void> {
  for (const run of await listRunningRuns(db)) {
    await executeClaimedRun(run, calendar, gmail, db, sender, options);
  }
}

export async function drainQueuedRuns(
  calendar: RecoveryCalendar,
  gmail: GmailClient,
  db: Pool = getDb(),
  sender: () => string = getGoogleSenderEmail,
  options: ExecutionOptions = {},
): Promise<number> {
  let claimed = 0;
  while (true) {
    const run = await claimNextRun(db, options.now?.() ?? new Date());
    if (!run) return claimed;
    claimed++;
    await executeClaimedRun(run, calendar, gmail, db, sender, options);
  }
}

export async function executePendingRuns(
  calendar: RecoveryCalendar,
  gmail: GmailClient,
  db: Pool = getDb(),
  sender: () => string = getGoogleSenderEmail,
  options: ExecutionOptions = {},
): Promise<number> {
  await recoverRunningRuns(calendar, gmail, db, sender, options);
  return drainQueuedRuns(calendar, gmail, db, sender, options);
}
