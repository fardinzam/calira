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

type CalendarCalls = {
  insertRequests: unknown[];
  insertOptions: unknown[];
  getRequests: unknown[];
  getOptions: unknown[];
  listRequests: unknown[];
  listOptions: unknown[];
  clientOptions: unknown[];
};

async function withCalendarApi(
  methods: {
    insert?: (request: unknown) => Promise<unknown>;
    get?: (request: unknown) => Promise<unknown>;
    list?: (request: unknown) => Promise<unknown>;
  },
  run: (calls: CalendarCalls) => Promise<void>,
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
  const calls: CalendarCalls = {
    insertRequests: [],
    insertOptions: [],
    getRequests: [],
    getOptions: [],
    listRequests: [],
    listOptions: [],
    clientOptions: [],
  };
  try {
    process.env.GOOGLE_CLIENT_ID = "fixture-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fixture-client-secret";
    process.env.GOOGLE_TOKEN_FILE = tokenFile;
    google.calendar = ((options: unknown) => {
      calls.clientOptions.push(options);
      return {
        events: {
          async insert(request: unknown, options: unknown) {
            calls.insertRequests.push(request);
            calls.insertOptions.push(options);
            if (!methods.insert) throw new Error("unexpected insert");
            return methods.insert(request);
          },
          async get(request: unknown, options: unknown) {
            calls.getRequests.push(request);
            calls.getOptions.push(options);
            if (!methods.get) throw new Error("unexpected get");
            return methods.get(request);
          },
          async list(request: unknown, options: unknown) {
            calls.listRequests.push(request);
            calls.listOptions.push(options);
            if (!methods.list) throw new Error("unexpected list");
            return methods.list(request);
          },
        },
      };
    }) as unknown as typeof google.calendar;
    await run(calls);
  } finally {
    google.calendar = originalCalendar;
    process.env = savedEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

async function withCalendarInsert(
  insert: (request: unknown) => Promise<unknown>,
  run: (
    requests: unknown[],
    clientOptions: unknown[],
    insertOptions: unknown[],
  ) => Promise<void>,
) {
  await withCalendarApi({ insert }, async (calls) => {
    await run(calls.insertRequests, calls.clientOptions, calls.insertOptions);
  });
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
          retryable: false,
        });
        assert.equal(requests.length, 1);
      },
    );
  }
});

test("only documented rate-limit insert rejections are retryable", async () => {
  for (const [status, reason, retryable] of [
    [429, undefined, true],
    [403, "rateLimitExceeded", true],
    [403, "userRateLimitExceeded", true],
    [403, "quotaExceeded", false],
  ] as const) {
    await withCalendarInsert(
      async () => {
        throw {
          response: {
            status,
            data: { error: { errors: [{ reason }], message: "private" } },
          },
        };
      },
      async (requests) => {
        assert.deepEqual(await calendarClient.insertEvent(input), {
          ok: false,
          certainty: "rejected",
          code: "calendar_rejected",
          message: "Google Calendar rejected the event request",
          retryable,
        });
        assert.equal(requests.length, 1);
      },
    );
  }
});

test("malformed Google error details cannot turn a 403 into a retry or leak", async () => {
  await withCalendarInsert(
    async () => {
      throw {
        response: {
          status: 403,
          data: { error: { errors: "private-invalid-detail" } },
        },
      };
    },
    async () => {
      const result = await calendarClient.insertEvent(input);
      assert.deepEqual(result, {
        ok: false,
        certainty: "rejected",
        code: "calendar_rejected",
        message: "Google Calendar rejected the event request",
        retryable: false,
      });
      assert.equal(JSON.stringify(result).includes("private"), false);
    },
  );
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

const matchingEvent = {
  id: input.eventId,
  status: "confirmed",
  summary: input.title,
  description: input.description,
  start: {
    dateTime: "2026-10-14T17:30:00Z",
    timeZone: input.timeZone,
  },
  end: {
    dateTime: "2026-10-14T18:30:00Z",
    timeZone: input.timeZone,
  },
};

test("lookup confirms only a matching saved event using instant comparison", async () => {
  await withCalendarApi(
    { get: async () => ({ data: matchingEvent }) },
    async (calls) => {
      assert.deepEqual(await calendarClient.lookupEvent(input), {
        kind: "found_match",
        eventId: input.eventId,
      });
      assert.equal(calls.clientOptions.length, 1);
      assert.deepEqual(calls.getRequests, [
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          fields:
            "id,status,summary,description,start(dateTime,timeZone),end(dateTime,timeZone)",
        },
      ]);
      assert.deepEqual(calls.getOptions, [{ retry: false }]);
      assert.equal(calls.listRequests.length, 0);
      assert.equal(calls.insertRequests.length, 0);
    },
  );
});

test("lookup accepts Google's omitted description for optional empty notes", async () => {
  await withCalendarApi(
    {
      get: async () => ({
        data: { ...matchingEvent, description: undefined },
      }),
    },
    async () => {
      assert.deepEqual(
        await calendarClient.lookupEvent({ ...input, description: "" }),
        { kind: "found_match", eventId: input.eventId },
      );
    },
  );
});

test("lookup rejects a found event with any mismatched saved field", async () => {
  const mismatches = [
    { id: "another-id" },
    { summary: "another title" },
    { description: "another description" },
    { status: "cancelled" },
    { start: { ...matchingEvent.start, dateTime: "2026-10-14T17:31:00Z" } },
    { end: { ...matchingEvent.end, dateTime: "2026-10-14T18:31:00Z" } },
    { start: { ...matchingEvent.start, timeZone: "Etc/UTC" } },
    { end: { ...matchingEvent.end, timeZone: "Etc/UTC" } },
  ];
  for (const difference of mismatches) {
    await withCalendarApi(
      { get: async () => ({ data: { ...matchingEvent, ...difference } }) },
      async (calls) => {
        assert.deepEqual(await calendarClient.lookupEvent(input), {
          kind: "found_mismatch",
        });
        assert.equal(calls.getRequests.length, 1);
        assert.equal(calls.listRequests.length, 0);
      },
    );
  }
});

test("event 404 means not found only after an accessible Calendar check", async () => {
  for (const accessRole of ["writer", "owner"]) {
    await withCalendarApi(
      {
        get: async () => {
          throw { response: { status: 404 } };
        },
        list: async () => ({ data: { accessRole } }),
      },
      async (calls) => {
        assert.deepEqual(await calendarClient.lookupEvent(input), {
          kind: "not_found",
        });
        assert.deepEqual(calls.listRequests, [
          { calendarId: input.calendarId, maxResults: 1, fields: "accessRole" },
        ]);
        assert.deepEqual(calls.listOptions, [{ retry: false }]);
        assert.equal(calls.getRequests.length, 1);
        assert.equal(calls.insertRequests.length, 0);
      },
    );
  }
});

test("event 404 with inaccessible Calendar remains unavailable", async () => {
  for (const listOutcome of [
    { data: { accessRole: "none" } },
    { data: { accessRole: "freeBusyReader" } },
    { data: { accessRole: "reader" } },
    { data: { accessRole: "writerWithoutPrivateAccess" } },
    { data: {} },
    { error: { response: { status: 403 } } },
    { error: { response: { status: 404 } } },
  ]) {
    await withCalendarApi(
      {
        get: async () => {
          throw { response: { status: 404 } };
        },
        list: async () => {
          if ("error" in listOutcome) throw listOutcome.error;
          return listOutcome;
        },
      },
      async (calls) => {
        assert.deepEqual(await calendarClient.lookupEvent(input), {
          kind: "unavailable",
          code: "calendar_lookup_unavailable",
          message: "Google Calendar event lookup is unavailable",
          retryable: false,
        });
        assert.equal(calls.getRequests.length, 1);
        assert.equal(calls.listRequests.length, 1);
      },
    );
  }
});

test("event 404 with a transient Calendar access check stays retryable and unresolved", async () => {
  await withCalendarApi(
    {
      get: async () => {
        throw { response: { status: 404 } };
      },
      list: async () => {
        throw { response: { status: 503, data: "private" } };
      },
    },
    async (calls) => {
      assert.deepEqual(await calendarClient.lookupEvent(input), {
        kind: "unavailable",
        code: "calendar_lookup_unavailable",
        message: "Google Calendar event lookup is unavailable",
        retryable: true,
      });
      assert.equal(calls.getRequests.length, 1);
      assert.equal(calls.listRequests.length, 1);
      assert.equal(calls.insertRequests.length, 0);
    },
  );
});

test("lookup permission failures are final; transport, rate, and server failures are retryable", async () => {
  for (const [error, retryable] of [
    [{ response: { status: 401, data: "private" } }, false],
    [{ response: { status: 403, data: "private" } }, false],
    [{ response: { status: 429, data: "private" } }, true],
    [{ response: { status: 503, data: "private" } }, true],
    [new Error("private-transport-detail"), true],
  ] as const) {
    await withCalendarApi(
      {
        get: async () => {
          throw error;
        },
      },
      async (calls) => {
        const result = await calendarClient.lookupEvent(input);
        assert.deepEqual(result, {
          kind: "unavailable",
          code: "calendar_lookup_unavailable",
          message: "Google Calendar event lookup is unavailable",
          retryable,
        });
        assert.equal(calls.getRequests.length, 1);
        assert.equal(calls.listRequests.length, 0);
        assert.equal(JSON.stringify(result).includes("private"), false);
      },
    );
  }
});
