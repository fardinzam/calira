import { setTimeout } from "node:timers/promises";
import { getDb } from "../lib/db";
import { getGoogleAuth } from "../lib/google/auth";
import { listFormResponses } from "../lib/google/forms";
import { pollEnabledWorkflows } from "./poll-forms";

async function pollOnce() {
  return pollEnabledWorkflows({ listFormResponses }, getDb());
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
      console.error("Forms polling failed; retrying next cycle");
    }
    await setTimeout(60_000);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker failed";
  console.error(
    /^(Missing GOOGLE_|GOOGLE_TOKEN_FILE)/.test(message)
      ? message
      : "Forms polling failed",
  );
  process.exitCode = 1;
});
