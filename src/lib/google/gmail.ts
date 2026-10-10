import { google } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import type { GmailClient, GmailMessageInput } from "../run-execution";
import { getGoogleAuth } from "./auth";

const singleEmail = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function validateMessage(input: GmailMessageInput): void {
  if (
    typeof input.from !== "string" ||
    !singleEmail.test(input.from) ||
    input.from.includes("..")
  ) {
    throw new Error("Invalid Gmail sender");
  }
  if (
    typeof input.to !== "string" ||
    !singleEmail.test(input.to) ||
    input.to.includes("..")
  ) {
    throw new Error("Invalid Gmail recipient");
  }
  if (typeof input.subject !== "string" || /[\r\n]/.test(input.subject)) {
    throw new Error("Invalid Gmail subject");
  }
}

export const gmailClient: GmailClient = {
  async sendMessage(input) {
    validateMessage(input);

    let raw: string;
    try {
      const mime = await new MailComposer({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.body,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
        .compile()
        .build();
      raw = mime.toString("base64url");
    } catch {
      throw new Error("Gmail message could not be prepared");
    }

    try {
      const api = google.gmail({ version: "v1", auth: await getGoogleAuth() });
      const response = await api.users.messages.send(
        { userId: "me", requestBody: { raw } },
        { retry: false },
      );
      const id = response.data.id;
      if (typeof id !== "string" || !id.trim()) {
        return {
          ok: false,
          certainty: "unknown",
          code: "gmail_missing_id",
          message: "Gmail send outcome could not be confirmed",
        };
      }
      return { ok: true, value: { messageId: id } };
    } catch (error) {
      const status = (error as { response?: { status?: unknown } })?.response
        ?.status;
      if ([400, 401, 403, 404].includes(status as number)) {
        return {
          ok: false,
          certainty: "rejected",
          code: "gmail_rejected",
          message: `Gmail send rejected (HTTP ${status})`,
        };
      }
      return {
        ok: false,
        certainty: "unknown",
        code: "gmail_send_unknown",
        message: "Gmail send outcome could not be confirmed",
      };
    }
  },
};
