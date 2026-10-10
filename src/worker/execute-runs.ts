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
  markFilterFailed,
  markFilteredOut,
  markFilterMatched,
  markValidationFailed,
  startCalendar,
  startGmail,
  type CalendarClient,
  type ClaimedRun,
  type GmailClient,
} from "../lib/run-execution";
import type { RunConfigSnapshot } from "../lib/workflow-config";

export async function executeClaimedRun(
  claim: ClaimedRun,
  calendar: CalendarClient,
  gmail: GmailClient,
  db: Pool,
  sender: () => string = getGoogleSenderEmail,
): Promise<void> {
  const snapshot = claim.snapshot as RunConfigSnapshot;
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

  let actions: ReturnType<typeof prepareActions>;
  try {
    actions = prepareActions(claim.answers, snapshot, sender());
  } catch {
    await markValidationFailed(
      claim.id,
      "invalid_action_input",
      "Required response values or sender address are invalid",
      db,
    );
    return;
  }
  await markFilterMatched(claim.id, db);

  const eventId = await startCalendar(claim.id, db);
  let calendarResult: Awaited<ReturnType<CalendarClient["insertEvent"]>>;
  try {
    calendarResult = await calendar.insertEvent({
      ...actions.calendar,
      eventId,
    });
  } catch {
    // The request may have reached Google. Leave this run unclaimable.
    return;
  }
  if (!calendarResult.ok) {
    if (calendarResult.certainty === "rejected") {
      await finishCalendarRejected(
        claim.id,
        calendarResult.code,
        calendarResult.message,
        db,
      );
    }
    return;
  }
  await finishCalendarSucceeded(claim.id, calendarResult.value.eventId, db);

  await startGmail(claim.id, db);
  let gmailResult: Awaited<ReturnType<GmailClient["sendMessage"]>>;
  try {
    gmailResult = await gmail.sendMessage(actions.gmail);
  } catch {
    // Gmail may have accepted the send. No automatic replay is safe.
    return;
  }
  if (!gmailResult.ok) {
    if (gmailResult.certainty === "rejected") {
      await finishGmailRejected(
        claim.id,
        gmailResult.code,
        gmailResult.message,
        db,
      );
    }
    return;
  }
  await finishGmailSucceeded(claim.id, gmailResult.value.messageId, db);
}

export async function executePendingRuns(
  calendar: CalendarClient,
  gmail: GmailClient,
  db: Pool = getDb(),
  sender: () => string = getGoogleSenderEmail,
): Promise<number> {
  let claimed = 0;
  while (true) {
    const run = await claimNextRun(db);
    if (!run) return claimed;
    claimed++;
    await executeClaimedRun(run, calendar, gmail, db, sender);
  }
}
