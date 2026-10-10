import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFilter, prepareActions } from "../src/lib/response-mapping";
import type { RunConfigSnapshot } from "../src/lib/workflow-config";
import { config } from "./workflow-fixtures";

const snapshot = {
  formId: "form-1",
  config: { ...config, calendarId: "primary" },
} as RunConfigSnapshot;

function answer(value: string) {
  return { textAnswers: { answers: [{ value }] } };
}

function answers(overrides: Record<string, unknown> = {}) {
  return {
    name: answer("Alex Rivera"),
    email: answer("alex@example.com"),
    request: answer("Consultation"),
    date: answer("2026-10-15"),
    time: answer("10:00"),
    notes: answer("Please call first."),
    ...overrides,
  };
}

test("Filter evaluates only the saved equality answer and rejects malformed values", () => {
  assert.equal(evaluateFilter(answers(), snapshot), "matched");
  assert.equal(
    evaluateFilter(answers({ request: answer(" Consultation ") }), snapshot),
    "filtered_out",
  );
  assert.equal(
    evaluateFilter(
      answers({ request: answer("Other"), name: undefined }),
      snapshot,
    ),
    "filtered_out",
  );
  for (const value of [
    undefined,
    answer(""),
    { textAnswers: { answers: [] } },
    {
      textAnswers: { answers: [{ value: "Consultation" }, { value: "Other" }] },
    },
  ]) {
    assert.throws(
      () => evaluateFilter(answers({ request: value }), snapshot),
      /Request type answer is invalid/,
    );
  }
});

test("valid matched response maps one request event and plain-text acknowledgement", () => {
  const result = prepareActions(answers(), snapshot, "owner@example.com");
  assert.deepEqual(result.calendar, {
    calendarId: "primary",
    title: "Consultation request — Alex Rivera",
    description: "Please call first.",
    startDateTime: "2026-10-15T10:00:00-07:00",
    endDateTime: "2026-10-15T11:00:00-07:00",
    timeZone: "America/Los_Angeles",
  });
  assert.deepEqual(result.gmail, {
    from: "owner@example.com",
    to: "alex@example.com",
    subject: "Request from Alex Rivera",
    body: "We received your Consultation request for 2026-10-15 at 10:00.\nPlease call first.",
  });
  assert.equal(
    prepareActions(answers({ notes: undefined }), snapshot, "owner@example.com")
      .calendar.description,
    "",
  );
});

test("required answers must have exactly one valid value before any action input exists", () => {
  const cases: Array<[string, unknown]> = [
    ["name", answer("  ")],
    ["name", answer("Alex\r\nBcc: other@example.com")],
    ["email", answer("Name <alex@example.com>")],
    ["email", answer("alex@example.com,other@example.com")],
    ["email", answer(".alex@example.com")],
    ["email", answer("alex@-example.com")],
    ["email", answer(`alex@${"a".repeat(64)}.com`)],
    ["date", answer("2026-02-30")],
    ["date", answer("10/15/2026")],
    ["date", answer(" 2026-10-15 ")],
    ["time", answer("25:00")],
    ["time", answer("10:00:00")],
    ["time", answer(" 10:00 ")],
    [
      "notes",
      { textAnswers: { answers: [{ value: "one" }, { value: "two" }] } },
    ],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () =>
        prepareActions(
          answers({ [key]: value }),
          snapshot,
          "owner@example.com",
        ),
      { name: "Error" },
      key,
    );
  }
  for (const key of ["name", "email", "request", "date", "time"]) {
    assert.throws(
      () =>
        prepareActions(
          answers({
            [key]: {
              textAnswers: { answers: [{ value: "one" }, { value: "two" }] },
            },
          }),
          snapshot,
          "owner@example.com",
        ),
      { name: "Error" },
      key,
    );
  }
  assert.throws(
    () =>
      prepareActions(
        answers(),
        snapshot,
        "owner@example.com\nBcc: x@example.com",
      ),
    /Sender address is invalid/,
  );
});

test("time conversion rejects DST gaps and overlaps and preserves elapsed duration across midnight", () => {
  for (const [date, time] of [
    ["2026-03-08", "02:30"],
    ["2026-11-01", "01:30"],
  ]) {
    assert.throws(
      () =>
        prepareActions(
          answers({ date: answer(date), time: answer(time) }),
          snapshot,
          "owner@example.com",
        ),
      /Requested date or time is invalid/,
    );
  }
  const rollover = prepareActions(
    answers({ date: answer("2028-02-29"), time: answer("23:30") }),
    snapshot,
    "owner@example.com",
  );
  assert.equal(rollover.calendar.endDateTime, "2028-03-01T00:30:00-08:00");
  const spring = prepareActions(
    answers({ date: answer("2026-03-08"), time: answer("01:30") }),
    snapshot,
    "owner@example.com",
  );
  assert.equal(spring.calendar.endDateTime, "2026-03-08T03:30:00-07:00");
  assert.throws(
    () =>
      prepareActions(
        answers({ date: answer("9999-12-31"), time: answer("23:30") }),
        snapshot,
        "owner@example.com",
      ),
    /Requested date or time is invalid/,
  );
});

test("corrupt saved snapshots and rendered header injection fail safely", () => {
  const invalidSnapshots = [
    { ...snapshot, config: { ...snapshot.config, timeZone: "UTC" } },
    {
      ...snapshot,
      config: {
        ...snapshot.config,
        questions: { ...snapshot.config.questions, email: "" },
      },
    },
    {
      ...snapshot,
      config: {
        ...snapshot.config,
        gmail: { ...snapshot.config.gmail, subject: "Hello {{unknown}}" },
      },
    },
  ];
  for (const bad of invalidSnapshots) {
    assert.throws(
      () => evaluateFilter(answers(), bad as RunConfigSnapshot),
      /Saved run configuration is invalid/,
    );
  }
  const unsafe = {
    ...snapshot,
    config: {
      ...snapshot.config,
      gmail: { ...snapshot.config.gmail, subject: "Hello {{notes}}" },
    },
  } as RunConfigSnapshot;
  assert.throws(
    () =>
      prepareActions(
        answers({ notes: answer("Hi\nBcc: x@example.com") }),
        unsafe,
        "owner@example.com",
      ),
    /Gmail subject is invalid/,
  );
});

test("Unicode names and notes remain content, not headers or metadata", () => {
  const result = prepareActions(
    answers({ name: answer("Zoë 李"), notes: answer("ありがとう") }),
    snapshot,
    "owner@example.com",
  );
  assert.equal(result.calendar.title, "Consultation request — Zoë 李");
  assert.equal(result.calendar.description, "ありがとう");
});
