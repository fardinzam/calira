"use client";

import { useEffect, useRef, useState } from "react";
import type { FormMetadata, WorkflowConfig } from "@/lib/workflow-config";
import { loadBuilderForm, saveBuilder } from "./actions";
import WorkflowPreview from "./workflow-preview";

type EditableWorkflow = {
  id: string;
  name: string;
  formId: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
};

const emptyConfig: WorkflowConfig = {
  calendarId: "",
  timeZone: "America/Los_Angeles",
  questions: {
    name: "",
    email: "",
    requestType: "",
    requestedDate: "",
    requestedTime: "",
    notes: "",
  },
  filter: { equals: "Consultation" },
  gmail: { subject: "", body: "" },
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function initialConfig(value: Record<string, unknown> | null): WorkflowConfig {
  const selected = value?.questions as Record<string, unknown> | undefined;
  const gmail = value?.gmail as Record<string, unknown> | undefined;
  return {
    ...emptyConfig,
    calendarId: text(value?.calendarId),
    questions: {
      name: text(selected?.name),
      email: text(selected?.email),
      requestType: text(selected?.requestType),
      requestedDate: text(selected?.requestedDate),
      requestedTime: text(selected?.requestedTime),
      notes: text(selected?.notes),
    },
    gmail: { subject: text(gmail?.subject), body: text(gmail?.body) },
  };
}

type QuestionKey = keyof WorkflowConfig["questions"];

function QuestionSelect({
  label,
  field,
  value,
  metadata,
  onChange,
}: {
  label: string;
  field: QuestionKey;
  value: string;
  metadata: FormMetadata | null;
  onChange: (field: QuestionKey, value: string) => void;
}) {
  const missing = Boolean(
    value &&
    metadata &&
    !metadata.questions.some((question) => question.id === value),
  );
  return (
    <div>
      <label htmlFor={field} className="block text-sm font-medium">
        {label} <span aria-label="required">*</span>
      </label>
      <select
        id={field}
        name={field}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        className="mt-1 block w-full rounded border border-gray-400 bg-white p-2"
      >
        <option value="">Select a Form question</option>
        {!metadata && value && (
          <option value={value}>Saved question ID: {value}</option>
        )}
        {missing && <option value={value}>Missing question ID: {value}</option>}
        {metadata?.questions.map((question) => (
          <option key={question.id} value={question.id}>
            {question.title} ({question.type}
            {question.required ? ", required" : ", optional"})
          </option>
        ))}
      </select>
      {missing && (
        <p className="mt-1 text-sm text-red-700">
          This saved question is missing from the Form.
        </p>
      )}
    </div>
  );
}

export default function WorkflowBuilder({
  workflow,
  initialError,
}: {
  workflow?: EditableWorkflow;
  initialError?: string;
}) {
  const [name, setName] = useState(workflow?.name ?? "");
  const [formId, setFormId] = useState(workflow?.formId ?? "");
  const formIdRef = useRef(formId);
  const [config, setConfig] = useState(() =>
    initialConfig(workflow?.config ?? null),
  );
  const [metadata, setMetadata] = useState<FormMetadata | null>(null);
  const [loading, setLoading] = useState(Boolean(workflow?.formId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(initialError ?? "");

  useEffect(() => {
    if (!workflow?.formId) return;
    let active = true;
    loadBuilderForm(workflow.formId).then((result) => {
      if (!active || formIdRef.current !== workflow.formId) return;
      if (result.metadata) setMetadata(result.metadata);
      if (result.error) setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [workflow?.formId]);

  async function loadQuestions() {
    const requestedId = formId;
    setLoading(true);
    setError("");
    setMetadata(null);
    const result = await loadBuilderForm(requestedId);
    if (formIdRef.current !== requestedId) return;
    if (result.metadata) setMetadata(result.metadata);
    if (result.error) setError(result.error);
    setLoading(false);
  }

  function setQuestion(field: QuestionKey, value: string) {
    setConfig((current) => ({
      ...current,
      questions: { ...current.questions, [field]: value },
    }));
  }

  async function save(saveAs: "draft" | "complete") {
    setSaving(true);
    setError("");
    const result = await saveBuilder({
      id: workflow?.id,
      name,
      formId,
      saveAs,
      calendarId: config.calendarId,
      questions: config.questions,
      subject: config.gmail.subject,
      body: config.gmail.body,
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
    }
  }

  return (
    <div className="mt-6 space-y-8">
      <p className="text-sm text-gray-700">
        Configure Forms → Filter → Calendar → Gmail. Saving prepares the
        workflow; enable it to record and process new responses.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded border border-red-300 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <section
        aria-labelledby="forms-step"
        className="space-y-4 rounded border border-gray-300 p-5"
      >
        <h2 id="forms-step" className="text-lg font-semibold">
          1. Google Forms
        </h2>
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Workflow name <span aria-label="required">*</span>
          </label>
          <input
            id="name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <div>
          <label htmlFor="formId" className="block text-sm font-medium">
            Google Form ID <span aria-label="required">*</span>
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="formId"
              name="formId"
              value={formId}
              disabled={workflow?.enabled}
              onChange={(event) => {
                setFormId(event.target.value);
                formIdRef.current = event.target.value;
                setLoading(false);
                setError("");
                setMetadata(null);
                setConfig((current) => ({
                  ...current,
                  questions: { ...emptyConfig.questions },
                }));
              }}
              className="min-w-0 flex-1 rounded border border-gray-400 p-2 disabled:bg-gray-100"
            />
            <button
              type="button"
              onClick={loadQuestions}
              disabled={loading || !formId.trim()}
              className="rounded border border-gray-500 px-3 py-2 text-sm disabled:opacity-50"
            >
              {loading ? "Loading…" : "Load questions"}
            </button>
          </div>
          {workflow?.enabled && (
            <p className="mt-1 text-sm text-gray-700">
              Disable this workflow before changing its Form ID.
            </p>
          )}
        </div>
        {!metadata && !loading && (
          <p className="text-sm text-gray-700">
            Load the Form to select named questions. Saved IDs remain visible
            while access is unavailable.
          </p>
        )}
        {metadata && (
          <p className="text-sm text-gray-700">
            {metadata.questions.length} questions loaded from this Form.
          </p>
        )}
        {metadata?.questions.length === 0 && (
          <p role="status" className="text-sm text-red-700">
            This Form has no questions to map.
          </p>
        )}
        {metadata?.questions.some(
          (question) => question.type === "unsupported",
        ) && (
          <p role="status" className="text-sm text-amber-800">
            Unsupported question types cannot complete the reference mapping.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <QuestionSelect
            label="Name — short answer"
            field="name"
            value={config.questions.name}
            metadata={metadata}
            onChange={setQuestion}
          />
          <QuestionSelect
            label="Email — short answer"
            field="email"
            value={config.questions.email}
            metadata={metadata}
            onChange={setQuestion}
          />
          <QuestionSelect
            label="Request type — multiple choice with Consultation"
            field="requestType"
            value={config.questions.requestType}
            metadata={metadata}
            onChange={setQuestion}
          />
          <QuestionSelect
            label="Requested date — Date with year"
            field="requestedDate"
            value={config.questions.requestedDate}
            metadata={metadata}
            onChange={setQuestion}
          />
          <QuestionSelect
            label="Requested time — Time of day"
            field="requestedTime"
            value={config.questions.requestedTime}
            metadata={metadata}
            onChange={setQuestion}
          />
          <QuestionSelect
            label="Notes — paragraph (answer optional)"
            field="notes"
            value={config.questions.notes}
            metadata={metadata}
            onChange={setQuestion}
          />
        </div>
        <p className="text-xs text-gray-600">
          The first five Form questions must be required. Notes may be optional.
        </p>
      </section>

      <section
        aria-labelledby="filter-step"
        className="space-y-2 rounded border border-gray-300 p-5"
      >
        <h2 id="filter-step" className="text-lg font-semibold">
          2. Filter
        </h2>
        <p className="text-sm">
          Continue only when the selected request type answer exactly equals{" "}
          <strong>Consultation</strong>.
        </p>
      </section>

      <section
        aria-labelledby="calendar-step"
        className="space-y-4 rounded border border-gray-300 p-5"
      >
        <h2 id="calendar-step" className="text-lg font-semibold">
          3. Google Calendar
        </h2>
        <div>
          <label htmlFor="calendarId" className="block text-sm font-medium">
            Calendar ID <span aria-label="required">*</span>
          </label>
          <input
            id="calendarId"
            name="calendarId"
            value={config.calendarId}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                calendarId: event.target.value,
              }))
            }
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <p className="text-sm">
          Provider time zone: <strong>America/Los_Angeles</strong>. Event
          duration: <strong>60 minutes</strong>.
        </p>
        <p className="text-sm">
          Title: Consultation request — selected name. Start: selected date
          (YYYY-MM-DD) and time (HH:mm). End: 60 minutes later. Description:
          selected notes.
        </p>
        <p className="text-xs text-gray-600">
          Saving does not test Calendar access or create an event.
        </p>
      </section>

      <section
        aria-labelledby="gmail-step"
        className="space-y-4 rounded border border-gray-300 p-5"
      >
        <h2 id="gmail-step" className="text-lg font-semibold">
          4. Gmail
        </h2>
        <p className="text-sm">
          Recipient: selected email answer. Sender: authorized account&apos;s
          primary address. Plain text only.
        </p>
        <div>
          <label htmlFor="subject" className="block text-sm font-medium">
            Subject <span aria-label="required">*</span>
          </label>
          <input
            id="subject"
            name="subject"
            value={config.gmail.subject}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                gmail: { ...current.gmail, subject: event.target.value },
              }))
            }
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <div>
          <label htmlFor="body" className="block text-sm font-medium">
            Body <span aria-label="required">*</span>
          </label>
          <textarea
            id="body"
            name="body"
            rows={5}
            value={config.gmail.body}
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                gmail: { ...current.gmail, body: event.target.value },
              }))
            }
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <p className="text-xs text-gray-600">
          Available placeholders: {"{{name}}"}, {"{{requestType}}"},{" "}
          {"{{requestedDate}}"}, {"{{requestedTime}}"}, {"{{notes}}"}. Unknown
          placeholders are rejected.
        </p>
      </section>

      <section aria-labelledby="review-step" className="space-y-4">
        <h2 id="review-step" className="text-lg font-semibold">
          5. Review and save
        </h2>
        <WorkflowPreview config={config} />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => save("draft")}
            disabled={saving}
            className="rounded border border-gray-500 px-4 py-2 text-sm disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => save("complete")}
            disabled={saving}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Save complete workflow
          </button>
        </div>
        {saving && (
          <p role="status" className="text-sm">
            Saving workflow…
          </p>
        )}
        <p className="text-xs text-gray-600">
          A complete workflow can be enabled after saving. The worker processes
          qualifying responses while the workflow is enabled.
        </p>
      </section>
    </div>
  );
}
