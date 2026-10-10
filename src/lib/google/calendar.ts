import { google } from "googleapis";
import type { CalendarClient } from "../run-execution";
import { getGoogleAuth } from "./auth";

export const calendarClient: CalendarClient = {
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
      const status = (error as { response?: { status?: unknown } })?.response
        ?.status;
      if (
        status === 400 ||
        status === 401 ||
        status === 403 ||
        status === 404
      ) {
        return {
          ok: false,
          certainty: "rejected",
          code: "calendar_rejected",
          message: "Google Calendar rejected the event request",
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
};
