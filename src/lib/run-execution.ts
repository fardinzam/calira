export type ActionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      certainty: "rejected" | "unknown";
      code: string;
      message: string;
    };

export type CalendarEventInput = {
  calendarId: string;
  eventId: string;
  title: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: "America/Los_Angeles";
};

export type GmailMessageInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type CalendarClient = {
  insertEvent(
    input: CalendarEventInput,
  ): Promise<ActionResult<{ eventId: string }>>;
};

export type GmailClient = {
  sendMessage(
    input: GmailMessageInput,
  ): Promise<ActionResult<{ messageId: string }>>;
};

export type RunDetail = {
  id: string;
  responseId: string;
  submittedAt: Date;
  state:
    | "queued"
    | "running"
    | "filtered_out"
    | "succeeded"
    | "failed"
    | "partially_failed";
  detectionOnly: boolean;
  error: { code: string; message: string } | null;
  steps: Array<{
    name: "filter" | "calendar" | "gmail";
    state:
      "pending" | "running" | "succeeded" | "skipped" | "failed" | "uncertain";
    attemptCount: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    summary: string | null;
    externalId: string | null;
    error: { code: string; message: string } | null;
  }>;
};
