"use server";

import { redirect } from "next/navigation";
import { saveWorkflow, setWorkflowEnabled } from "@/lib/workflows";
import { getFormQuestions } from "@/lib/google/form-metadata";
import { saveBuilderWorkflow } from "./builder-save";

export type SubmittedBuilderInput = {
  id?: string;
  name: string;
  formId: string;
  saveAs: "draft" | "complete";
  calendarId: string;
  questions: {
    name: string;
    email: string;
    requestType: string;
    requestedDate: string;
    requestedTime: string;
    notes: string;
  };
  subject: string;
  body: string;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeBuilderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /^(Workflow name is required|Form ID is required|Complete all required fields|Form metadata does not match|.* question does not match|.* question is required|Select a different question|Request type question needs|Calendar ID is required|Provider time zone must|Filter must|Gmail subject is required|Gmail body is required|Gmail subject must|Unknown message placeholder|Invalid message placeholder|Disable the workflow before|Form metadata is required|Workflow not found|Cannot read Form questions|Could not load Form questions|Google authorization expired)/.test(
      message,
    )
  ) {
    return message;
  }
  return "Could not save the workflow. Please try again.";
}

export async function loadBuilderForm(formId: string) {
  try {
    return { metadata: await getFormQuestions(stringValue(formId).trim()) };
  } catch (error) {
    const message = safeBuilderError(error);
    return {
      error:
        message === "Could not save the workflow. Please try again."
          ? "Could not load Form questions; check Form ID and owner access"
          : message,
    };
  }
}

export async function saveBuilder(input: SubmittedBuilderInput) {
  if (!input || (input.saveAs !== "draft" && input.saveAs !== "complete")) {
    return { error: "Choose Save draft or Save complete workflow" };
  }
  let savedId: string;
  try {
    const saved = await saveBuilderWorkflow({
      id: stringValue(input.id) || undefined,
      name: stringValue(input.name),
      formId: stringValue(input.formId),
      saveAs: input.saveAs,
      config: {
        calendarId: stringValue(input.calendarId),
        timeZone: "America/Los_Angeles",
        questions: {
          name: stringValue(input.questions?.name),
          email: stringValue(input.questions?.email),
          requestType: stringValue(input.questions?.requestType),
          requestedDate: stringValue(input.questions?.requestedDate),
          requestedTime: stringValue(input.questions?.requestedTime),
          notes: stringValue(input.questions?.notes),
        },
        filter: { equals: "Consultation" },
        gmail: {
          subject: stringValue(input.subject),
          body: stringValue(input.body),
        },
      },
    });
    savedId = saved.id;
  } catch (error) {
    return { error: safeBuilderError(error) };
  }
  redirect(`/workflows/${savedId}?saved=${input.saveAs}`);
}

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
