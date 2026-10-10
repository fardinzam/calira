import assert from "node:assert/strict";
import test from "node:test";
import { getGoogleSenderEmail, googleScopes } from "../src/lib/google/auth";

test("authorization requests only the four reference API scopes", () => {
  assert.deepEqual(googleScopes, [
    "https://www.googleapis.com/auth/forms.responses.readonly",
    "https://www.googleapis.com/auth/forms.body.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
});

test("sender setting names missing or invalid values without revealing them", () => {
  assert.throws(() => getGoogleSenderEmail({}), /Missing GOOGLE_SENDER_EMAIL/);
  for (const value of [
    "a,b@example.com",
    "Name <a@example.com>",
    "a@example.com\r\nBcc: other@example.com",
    "a:b@example.com",
    "a@example.com(comment)",
    "a@example.com\u0000",
    "invalid",
  ]) {
    assert.throws(
      () => getGoogleSenderEmail({ GOOGLE_SENDER_EMAIL: value }),
      (error: Error) =>
        /Invalid GOOGLE_SENDER_EMAIL/.test(error.message) &&
        !error.message.includes(value),
    );
  }
  assert.equal(
    getGoogleSenderEmail({ GOOGLE_SENDER_EMAIL: " owner@example.com " }),
    "owner@example.com",
  );
});
