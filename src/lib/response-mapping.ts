import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEventInput, GmailMessageInput } from "./run-execution";
import type { RunConfigSnapshot } from "./workflow-config";

const fields = [
  "name",
  "email",
  "requestType",
  "requestedDate",
  "requestedTime",
  "notes",
] as const;
const placeholders = new Set([
  "name",
  "requestType",
  "requestedDate",
  "requestedTime",
  "notes",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validTemplate(value: string): boolean {
  const rest = value.replace(/{{([^{}]+)}}/g, (_match, key: string) =>
    placeholders.has(key) ? "" : "{{invalid}}",
  );
  return !rest.includes("{{") && !rest.includes("}}");
}

function checkedSnapshot(value: unknown): RunConfigSnapshot {
  const root = record(value);
  const config = record(root.config);
  const questions = record(config.questions);
  const filter = record(config.filter);
  const gmail = record(config.gmail);
  const ids = fields.map((field) => questions[field]);
  if (
    typeof root.formId !== "string" ||
    !root.formId.trim() ||
    typeof config.calendarId !== "string" ||
    !config.calendarId.trim() ||
    config.timeZone !== "America/Los_Angeles" ||
    filter.equals !== "Consultation" ||
    ids.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(ids).size !== fields.length ||
    typeof gmail.subject !== "string" ||
    !gmail.subject.trim() ||
    typeof gmail.body !== "string" ||
    !gmail.body.trim() ||
    !validTemplate(gmail.subject) ||
    !validTemplate(gmail.body)
  ) {
    throw new Error("Saved run configuration is invalid");
  }
  return value as RunConfigSnapshot;
}

function answerText(
  answers: Record<string, unknown>,
  questionId: string,
  label: string,
  optional = false,
  trim = true,
): string {
  const raw = answers[questionId];
  if (raw === undefined && optional) return "";
  const values = record(record(raw).textAnswers).answers;
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    typeof record(values[0]).value !== "string"
  ) {
    throw new Error(`${label} answer is invalid`);
  }
  const text = record(values[0]).value as string;
  if (!text.trim() && !optional) throw new Error(`${label} answer is invalid`);
  return trim ? text.trim() : text;
}

function bareEmail(value: string): boolean {
  if (value.length > 254 || /[\r\n\s,;<>():\u0000-\u001f]/.test(value))
    return false;
  const pieces = value.split("@");
  if (pieces.length !== 2) return false;
  const [local, domain] = pieces;
  if (
    !local ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  )
    return false;
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return false;
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    ) &&
    /^[A-Za-z]{2,}$/.test(labels.at(-1)!)
  );
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(
    /{{([^{}]+)}}/g,
    (_match, key: string) => values[key],
  );
}

export function evaluateFilter(
  answers: Record<string, unknown>,
  snapshot: RunConfigSnapshot,
): "matched" | "filtered_out" {
  const saved = checkedSnapshot(snapshot);
  const requestType = answerText(
    record(answers),
    saved.config.questions.requestType,
    "Request type",
    false,
    false,
  );
  return requestType === saved.config.filter.equals
    ? "matched"
    : "filtered_out";
}

export function prepareActions(
  answers: Record<string, unknown>,
  snapshot: RunConfigSnapshot,
  senderEmail: string,
): { calendar: Omit<CalendarEventInput, "eventId">; gmail: GmailMessageInput } {
  const saved = checkedSnapshot(snapshot);
  const source = record(answers);
  if (evaluateFilter(source, saved) !== "matched")
    throw new Error("Response does not match Filter");
  const selected = saved.config.questions;
  const name = answerText(source, selected.name, "Name");
  if (/[\r\n]/.test(name)) throw new Error("Name answer is invalid");
  const email = answerText(source, selected.email, "Email");
  if (!bareEmail(email)) throw new Error("Email answer is invalid");
  if (!bareEmail(senderEmail)) throw new Error("Sender address is invalid");
  const requestType = answerText(
    source,
    selected.requestType,
    "Request type",
    false,
    false,
  );
  const requestedDate = answerText(
    source,
    selected.requestedDate,
    "Requested date",
    false,
    false,
  );
  const requestedTime = answerText(
    source,
    selected.requestedTime,
    "Requested time",
    false,
    false,
  );
  const notes = answerText(source, selected.notes, "Notes", true);
  let start: Temporal.ZonedDateTime;
  let end: Temporal.ZonedDateTime;
  try {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ||
      !/^\d{2}:\d{2}$/.test(requestedTime)
    ) {
      throw new Error();
    }
    const plain = Temporal.PlainDateTime.from(
      `${requestedDate}T${requestedTime}:00`,
      { overflow: "reject" },
    );
    start = plain.toZonedDateTime(saved.config.timeZone, {
      disambiguation: "reject",
    });
    end = start.add({ minutes: 60 });
    if (start.year < 1 || end.year > 9999) throw new Error();
  } catch {
    throw new Error("Requested date or time is invalid");
  }
  const values = { name, requestType, requestedDate, requestedTime, notes };
  const subject = render(saved.config.gmail.subject, values);
  const body = render(saved.config.gmail.body, values);
  if (!subject.trim() || /[\r\n]/.test(subject))
    throw new Error("Gmail subject is invalid");
  if (!body.trim()) throw new Error("Gmail body is invalid");
  return {
    calendar: {
      calendarId: saved.config.calendarId,
      title: `Consultation request — ${name}`,
      description: notes,
      startDateTime: start.toString({ timeZoneName: "never" }),
      endDateTime: end.toString({ timeZoneName: "never" }),
      timeZone: saved.config.timeZone,
    },
    gmail: { from: senderEmail, to: email, subject, body },
  };
}
