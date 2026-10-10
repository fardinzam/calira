import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { google } from "googleapis";
import { calendarClient } from "../src/lib/google/calendar";
import type { CalendarEventInput } from "../src/lib/run-execution";

const input: CalendarEventInput = {
  calendarId: "primary",
  eventId: "a0123456789abcdef",
  title: "Consultation request for Example Person",
  description: "Example notes",
  startDateTime: "2026-10-14T10:30:00-07:00",
  endDateTime: "2026-10-14T11:30:00-07:00",
  timeZone: "America/Los_Angeles",
};

async function withCalendarInsert(
  insert: (request: unknown) => Promise<unknown>,
  run: (
    requests: unknown[],
    clientOptions: unknown[],
    insertOptions: unknown[],
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "automator-calendar-"));
  const tokenFile = join(directory, "token.json");
  await writeFile(
    tokenFile,
    JSON.stringify({ refresh_token: "fixture-token" }),
    {
      mode: 0o600,
    },
  );
  const savedEnv = { ...process.env };
  const originalCalendar = google.calendar;
  const requests: unknown[] = [];
  const clientOptions: unknown[] = [];
  const insertOptions: unknown[] = [];
  try {
    process.env.GOOGLE_CLIENT_ID = "fixture-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fixture-client-secret";
    process.env.GOOGLE_TOKEN_FILE = tokenFile;
    google.calendar = ((options: unknown) => {
      clientOptions.push(options);
      return {
        events: {
          async insert(request: unknown, options: unknown) {
            requests.push(request);
            insertOptions.push(options);
            return insert(request);
          },
        },
      };
    }) as unknown as typeof google.calendar;
    await run(requests, clientOptions, insertOptions);
  } finally {
    google.calendar = originalCalendar;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

test("inserts one event with only the configured ID and required event fields", async () => {
  await withCalendarInsert(
    async () => ({ data: { id: input.eventId } }),
    async (requests, clientOptions) => {
      assert.deepEqual(await calendarClient.insertEvent(input), {
        ok: true,
        value: { eventId: input.eventId },
      });
      assert.equal(clientOptions.length, 1);
      assert.equal((clientOptions[0] as { version: string }).version, "v3");
      assert.ok((clientOptions[0] as { auth?: unknown }).auth);
      assert.deepEqual(requests, [
        {
          calendarId: "primary",
          requestBody: {
            id: "a0123456789abcdef",
            summary: "Consultation request for Example Person",
            description: "Example notes",
            start: {
              dateTime: "2026-10-14T10:30:00-07:00",
              timeZone: "America/Los_Angeles",
            },
            end: {
              dateTime: "2026-10-14T11:30:00-07:00",
              timeZone: "America/Los_Angeles",
            },
          },
        },
      ]);
    },
  );
});

test("disables Google client retries for the event insert", async () => {
  await withCalendarInsert(
    async () => ({ data: { id: input.eventId } }),
    async (_requests, _clientOptions, insertOptions) => {
      await calendarClient.insertEvent(input);
      assert.deepEqual(insertOptions, [{ retry: false }]);
    },
  );
});

test("confirmed client and authorization rejections are safe and definite", async () => {
  for (const status of [400, 401, 403, 404]) {
    await withCalendarInsert(
      async () => {
        throw {
          response: { status, data: { error: "private-response-body" } },
          message: "private-event-notes",
        };
      },
      async (requests) => {
        assert.deepEqual(await calendarClient.insertEvent(input), {
          ok: false,
          certainty: "rejected",
          code: "calendar_rejected",
          message: "Google Calendar rejected the event request",
        });
        assert.equal(requests.length, 1);
      },
    );
  }
});

test("transport, server, and collision errors have unknown outcomes", async () => {
  for (const error of [
    new Error("private-timeout-detail"),
    { response: { status: 503, data: "private-response-body" } },
    { response: { status: 409, data: "private-collision-detail" } },
  ]) {
    await withCalendarInsert(
      async () => {
        throw error;
      },
      async (requests) => {
        assert.deepEqual(await calendarClient.insertEvent(input), {
          ok: false,
          certainty: "unknown",
          code: "calendar_unknown",
          message: "Google Calendar event outcome is unknown",
        });
        assert.equal(requests.length, 1);
      },
    );
  }
});

test("missing or mismatched returned event IDs have unknown outcomes", async () => {
  for (const data of [{}, { id: "different-event-id" }]) {
    await withCalendarInsert(
      async () => ({ data }),
      async (requests) => {
        assert.deepEqual(await calendarClient.insertEvent(input), {
          ok: false,
          certainty: "unknown",
          code: "calendar_unknown",
          message: "Google Calendar event outcome is unknown",
        });
        assert.equal(requests.length, 1);
      },
    );
  }
});
