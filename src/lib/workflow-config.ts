export type FormQuestion = {
  id: string;
  title: string;
  type:
    | "shortText"
    | "paragraph"
    | "multipleChoice"
    | "date"
    | "time"
    | "unsupported";
  required: boolean;
  options?: string[];
  hasYear?: boolean;
  includeTime?: boolean;
  duration?: boolean;
};

export type FormMetadata = {
  formId: string;
  questions: FormQuestion[];
};

export type WorkflowConfig = {
  calendarId: string;
  timeZone: "America/Los_Angeles";
  questions: {
    name: string;
    email: string;
    requestType: string;
    requestedDate: string;
    requestedTime: string;
    notes: string;
  };
  filter: { equals: "Consultation" };
  gmail: { subject: string; body: string };
};

export type RunConfigSnapshot = { formId: string; config: WorkflowConfig };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function hasCompleteWorkflowFields(value: unknown): boolean {
  const input = record(value);
  const selected = record(input.questions);
  const filter = record(input.filter);
  const gmail = record(input.gmail);
  return [
    input.calendarId,
    input.timeZone,
    selected.name,
    selected.email,
    selected.requestType,
    selected.requestedDate,
    selected.requestedTime,
    selected.notes,
    filter.equals,
    gmail.subject,
    gmail.body,
  ].every((part) => typeof part === "string" && part.trim().length > 0);
}

function checkPlaceholders(value: string): void {
  const allowed = new Set([
    "name",
    "requestType",
    "requestedDate",
    "requestedTime",
    "notes",
  ]);
  const withoutKnown = value.replace(/{{([^{}]+)}}/g, (_match, key: string) => {
    if (!allowed.has(key)) throw new Error("Unknown message placeholder");
    return "";
  });
  if (withoutKnown.includes("{{") || withoutKnown.includes("}}")) {
    throw new Error("Invalid message placeholder");
  }
}

export function validateWorkflowConfig(
  value: unknown,
  form: FormMetadata,
): WorkflowConfig {
  const input = record(value);
  const selected = record(input.questions);
  const filter = record(input.filter);
  const gmail = record(input.gmail);
  const questions = {
    name: requiredString(selected.name, "Name question"),
    email: requiredString(selected.email, "Email question"),
    requestType: requiredString(selected.requestType, "Request type question"),
    requestedDate: requiredString(selected.requestedDate, "Date question"),
    requestedTime: requiredString(selected.requestedTime, "Time question"),
    notes: requiredString(selected.notes, "Notes question"),
  };
  if (new Set(Object.values(questions)).size !== 6) {
    throw new Error("Select a different question for each field");
  }

  const expected: Array<{
    key: keyof typeof questions;
    type: FormQuestion["type"];
    required: boolean;
  }> = [
    { key: "name", type: "shortText", required: true },
    { key: "email", type: "shortText", required: true },
    { key: "requestType", type: "multipleChoice", required: true },
    { key: "requestedDate", type: "date", required: true },
    { key: "requestedTime", type: "time", required: true },
    { key: "notes", type: "paragraph", required: false },
  ];
  for (const field of expected) {
    const question = form.questions.find(
      (item) => item.id === questions[field.key],
    );
    if (
      !question ||
      question.type !== field.type ||
      (field.required && !question.required) ||
      (field.key === "requestedDate" &&
        (!question.hasYear || question.includeTime)) ||
      (field.key === "requestedTime" && question.duration)
    ) {
      throw new Error(
        `${field.key} question does not match the reference Form`,
      );
    }
    if (
      field.key === "requestType" &&
      !question.options?.includes("Consultation")
    ) {
      throw new Error("Request type question needs a Consultation choice");
    }
  }

  const calendarId = requiredString(input.calendarId, "Calendar ID");
  if (input.timeZone !== "America/Los_Angeles") {
    throw new Error("Provider time zone must be America/Los_Angeles");
  }
  if (filter.equals !== "Consultation") {
    throw new Error("Filter must equal Consultation");
  }
  const subject = requiredString(gmail.subject, "Gmail subject");
  const body = requiredString(gmail.body, "Gmail body");
  if (/[\r\n]/.test(subject)) throw new Error("Gmail subject must be one line");
  checkPlaceholders(subject);
  checkPlaceholders(body);
  return {
    calendarId,
    timeZone: "America/Los_Angeles",
    questions,
    filter: { equals: "Consultation" },
    gmail: { subject, body },
  };
}
