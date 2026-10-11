import { google } from "googleapis";
import type {
  CalendarClient,
  CalendarLookupClient,
  CalendarLookupResult,
} from "../run-execution";
import { getGoogleAuth } from "./auth";

function responseStatus(error: unknown): unknown {
  return (error as { response?: { status?: unknown } })?.response?.status;
}

function isRateLimitRejection(error: unknown): boolean {
  const response = (
    error as {
      response?: {
        status?: unknown;
        data?: { error?: { errors?: Array<{ reason?: unknown }> } };
      };
    }
  )?.response;
  if (response?.status === 429) return true;
  const reasons = response?.data?.error?.errors;
  return (
    response?.status === 403 &&
    Array.isArray(reasons) &&
    reasons.some(
      (item) =>
        item?.reason === "rateLimitExceeded" ||
        item?.reason === "userRateLimitExceeded",
    ) === true
  );
}

function unavailable(retryable: boolean): CalendarLookupResult {
  return {
    kind: "unavailable",
    code: "calendar_lookup_unavailable",
    message: "Google Calendar event lookup is unavailable",
    retryable,
  };
}

function isRetryableLookupError(error: unknown): boolean {
  const status = responseStatus(error);
  return status === 429 || typeof status !== "number" || status >= 500;
}

function sameInstant(
  actual: string | null | undefined,
  expected: string,
): boolean {
  if (typeof actual !== "string") return false;
  const actualTime = Date.parse(actual);
  return Number.isFinite(actualTime) && actualTime === Date.parse(expected);
}

export const calendarClient: CalendarClient & CalendarLookupClient = {
  async insertEvent(input) {
    try {
      const calendar = google.calendar({
        version: "v3",
        auth: await getGoogleAuth(),
      });
      const response = await calendar.events.insert(
        {
          calendarId: input.calendarId,
          requestBody: {
            id: input.eventId,
            summary: input.title,
            description: input.description,
            start: {
              dateTime: input.startDateTime,
              timeZone: input.timeZone,
            },
            end: {
              dateTime: input.endDateTime,
              timeZone: input.timeZone,
            },
          },
        },
        { retry: false },
      );

      if (response.data.id === input.eventId) {
        return { ok: true, value: { eventId: input.eventId } };
      }
    } catch (error) {
      const status = responseStatus(error);
      if (
        status === 400 ||
        status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 429
      ) {
        return {
          ok: false,
          certainty: "rejected",
          code: "calendar_rejected",
          message: "Google Calendar rejected the event request",
          retryable: isRateLimitRejection(error),
        };
      }
    }

    return {
      ok: false,
      certainty: "unknown",
      code: "calendar_unknown",
      message: "Google Calendar event outcome is unknown",
    };
  },

  async lookupEvent(input) {
    let calendar: ReturnType<typeof google.calendar>;
    try {
      calendar = google.calendar({
        version: "v3",
        auth: await getGoogleAuth(),
      });
    } catch {
      return unavailable(false);
    }

    try {
      const response = await calendar.events.get(
        {
          calendarId: input.calendarId,
          eventId: input.eventId,
          fields:
            "id,status,summary,description,start(dateTime,timeZone),end(dateTime,timeZone)",
        },
        { retry: false },
      );
      const event = response.data;
      if (
        event.id === input.eventId &&
        event.status !== "cancelled" &&
        event.summary === input.title &&
        (event.description ?? "") === input.description &&
        sameInstant(event.start?.dateTime, input.startDateTime) &&
        event.start?.timeZone === input.timeZone &&
        sameInstant(event.end?.dateTime, input.endDateTime) &&
        event.end?.timeZone === input.timeZone
      ) {
        return { kind: "found_match", eventId: input.eventId };
      }
      return { kind: "found_mismatch" };
    } catch (error) {
      if (responseStatus(error) !== 404) {
        return unavailable(isRetryableLookupError(error));
      }
    }

    try {
      const response = await calendar.events.list(
        { calendarId: input.calendarId, maxResults: 1, fields: "accessRole" },
        { retry: false },
      );
      if (["writer", "owner"].includes(response.data.accessRole ?? "")) {
        return { kind: "not_found" };
      }
      return unavailable(false);
    } catch (error) {
      return unavailable(isRetryableLookupError(error));
    }
  },
};
