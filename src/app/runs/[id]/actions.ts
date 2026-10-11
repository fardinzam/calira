"use server";

import { redirect } from "next/navigation";
import { requestGmailRetry } from "@/lib/run-execution";

export async function retryGmailAction(runId: string, formData: FormData) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      runId,
    )
  ) {
    redirect("/runs");
  }

  const acknowledgment = formData.getAll("acknowledgeDuplicateRisk");
  const acknowledged =
    acknowledgment.length === 1 && acknowledgment[0] === "yes";
  let result: "queued" | "not_allowed" | "warning_required" | "error";
  try {
    result = await requestGmailRetry(runId, acknowledged);
  } catch {
    result = "error";
  }
  redirect(`/runs/${runId}?retry=${result}`);
}
