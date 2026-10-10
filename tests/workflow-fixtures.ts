import type { FormQuestion } from "../src/lib/workflow-config";

export const questions: FormQuestion[] = [
  { id: "name", title: "Name", type: "shortText", required: true },
  { id: "email", title: "Email", type: "shortText", required: true },
  {
    id: "request",
    title: "Request type",
    type: "multipleChoice",
    required: true,
    options: ["Consultation", "Other"],
  },
  {
    id: "date",
    title: "Requested date",
    type: "date",
    required: true,
    hasYear: true,
    includeTime: false,
  },
  {
    id: "time",
    title: "Requested time",
    type: "time",
    required: true,
    duration: false,
  },
  { id: "notes", title: "Notes", type: "paragraph", required: false },
];

export const config = {
  calendarId: " primary ",
  timeZone: "America/Los_Angeles",
  questions: {
    name: "name",
    email: "email",
    requestType: "request",
    requestedDate: "date",
    requestedTime: "time",
    notes: "notes",
  },
  filter: { equals: "Consultation" },
  gmail: {
    subject: "Request from {{name}}",
    body: "We received your {{requestType}} request for {{requestedDate}} at {{requestedTime}}.\n{{notes}}",
  },
};

export const metadata = { formId: "form-1", questions };

export function metadataFor(formId: string) {
  return { formId, questions };
}
