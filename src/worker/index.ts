import { setTimeout } from "node:timers/promises";
import { getDb } from "../lib/db";
import { withWorkerLock } from "../lib/run-execution";
import { getGoogleAuth } from "../lib/google/auth";
import { calendarClient } from "../lib/google/calendar";
import { listFormResponses } from "../lib/google/forms";
import { gmailClient } from "../lib/google/gmail";
import { drainQueuedRuns, recoverRunningRuns } from "./execute-runs";
import { pollEnabledWorkflows } from "./poll-forms";

async function pollOnce() {
  return withWorkerLock(getDb(), async (assertActive) => {
    await assertActive();
    await recoverRunningRuns(calendarClient, gmailClient, getDb(), undefined, {
      assertActive,
    });
    await assertActive();
    const failure = await pollEnabledWorkflows(
      {
        async listFormResponses(formId, since, pageToken) {
          await assertActive();
          return listFormResponses(formId, since, pageToken);
        },
      },
      getDb(),
    );
    await assertActive();
    await drainQueuedRuns(calendarClient, gmailClient, getDb(), undefined, {
      assertActive,
    });
    return failure;
  });
}

async function main() {
  await getGoogleAuth();
  if (process.argv.includes("--once")) {
    try {
      const failure = await pollOnce();
      if (failure) {
        console.error(failure);
        process.exitCode = 1;
      }
    } finally {
      await getDb().end();
    }
    return;
  }

  while (true) {
    try {
      const failure = await pollOnce();
      if (failure) console.error(failure);
    } catch {
      console.error("Worker cycle failed; retrying next cycle");
    }
    await setTimeout(60_000);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker failed";
  console.error(
    /^(Missing GOOGLE_|GOOGLE_TOKEN_FILE)/.test(message)
      ? message
      : "Worker cycle failed",
  );
  process.exitCode = 1;
});
