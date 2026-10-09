"use server";

import { redirect } from "next/navigation";
import { saveWorkflow, setWorkflowEnabled } from "@/lib/workflows";

export async function createWorkflow(formData: FormData): Promise<void> {
  try {
    await saveWorkflow({
      name: String(formData.get("name") ?? ""),
      formId: String(formData.get("formId") ?? ""),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Workflow name is required"
    ) {
      redirect("/workflows/new?error=name");
    }
    if (error instanceof Error && error.message === "Form ID is required") {
      redirect("/workflows/new?error=formId");
    }
    redirect("/workflows/new?error=save");
  }
  redirect("/");
}

export async function toggleWorkflow(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const enabled = formData.get("enabled");
  if (
    typeof id !== "string" ||
    !id ||
    (enabled !== "true" && enabled !== "false")
  ) {
    redirect("/?error=update");
  }
  try {
    await setWorkflowEnabled(id, enabled === "true", new Date());
  } catch {
    redirect("/?error=update");
  }
  redirect("/");
}
