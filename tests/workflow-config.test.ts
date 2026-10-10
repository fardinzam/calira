import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflowConfig } from "../src/lib/workflow-config";
import { config, metadata, questions } from "./workflow-fixtures";

test("validates the fixed reference mapping and trims the Calendar ID", () => {
  const actual = validateWorkflowConfig(config, metadata);
  assert.equal(actual.calendarId, "primary");
  assert.equal(actual.questions.requestedDate, "date");
  assert.equal(actual.gmail.subject, "Request from {{name}}");
});

test("rejects an incomplete mapping and duplicate question IDs", () => {
  assert.throws(
    () =>
      validateWorkflowConfig(
        { ...config, questions: { ...config.questions, email: "" } },
        metadata,
      ),
    /email question/i,
  );
  assert.throws(
    () =>
      validateWorkflowConfig(
        { ...config, questions: { ...config.questions, email: "name" } },
        metadata,
      ),
    /different question/i,
  );
});

test("rejects a wrong question type, optional required field, or missing Consultation choice", () => {
  assert.throws(
    () =>
      validateWorkflowConfig(config, {
        ...metadata,
        questions: questions.map((question) =>
          question.id === "date" ? { ...question, hasYear: false } : question,
        ),
      }),
    /date question/i,
  );
  assert.throws(
    () =>
      validateWorkflowConfig(config, {
        ...metadata,
        questions: questions.map((question) =>
          question.id === "email" ? { ...question, required: false } : question,
        ),
      }),
    /email question/i,
  );
  assert.throws(
    () =>
      validateWorkflowConfig(config, {
        ...metadata,
        questions: questions.map((question) =>
          question.id === "request"
            ? { ...question, options: ["Other"] }
            : question,
        ),
      }),
    /Consultation choice/i,
  );
});

test("rejects unknown placeholders and unsafe subject headers", () => {
  assert.throws(
    () =>
      validateWorkflowConfig(
        { ...config, gmail: { ...config.gmail, body: "Hi {{unknown}}" } },
        metadata,
      ),
    /placeholder/i,
  );
  assert.throws(
    () =>
      validateWorkflowConfig(
        { ...config, gmail: { ...config.gmail, subject: "Hi\nBcc: a@b" } },
        metadata,
      ),
    /subject/i,
  );
});

test("rejects combined date-time and elapsed-duration questions", () => {
  assert.throws(
    () =>
      validateWorkflowConfig(config, {
        ...metadata,
        questions: questions.map((question) =>
          question.id === "date"
            ? { ...question, includeTime: true }
            : question,
        ),
      }),
    /date question/i,
  );
  assert.throws(
    () =>
      validateWorkflowConfig(config, {
        ...metadata,
        questions: questions.map((question) =>
          question.id === "time" ? { ...question, duration: true } : question,
        ),
      }),
    /time question/i,
  );
});
