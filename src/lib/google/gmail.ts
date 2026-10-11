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
      return {
        ok: false,
        certainty: "rejected",
        code: "gmail_message_preparation_failed",
        message: "Gmail message could not be prepared",
        retryable: false,
      };
    }

    let api: ReturnType<typeof google.gmail>;
    try {
      api = google.gmail({ version: "v1", auth: await getGoogleAuth() });
    } catch {
      return {
        ok: false,
        certainty: "rejected",
        code: "gmail_auth_unavailable",
        message: "Gmail authorization is unavailable",
        retryable: false,
      };
    }

    try {
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
      const response = (
        error as {
          response?: {
            status?: unknown;
            data?: { error?: { errors?: unknown } };
          };
        }
      )?.response;
      const status = response?.status;
      const reasons = response?.data?.error?.errors;
      const rateLimitReason =
        Array.isArray(reasons) &&
        reasons.some(
          (item: unknown) =>
            item !== null &&
            typeof item === "object" &&
            "reason" in item &&
            (item.reason === "rateLimitExceeded" ||
              item.reason === "userRateLimitExceeded"),
        );
      if ([400, 401, 403, 404, 429].includes(status as number)) {
        return {
          ok: false,
          certainty: "rejected",
          code: "gmail_rejected",
          message: `Gmail send rejected (HTTP ${status})`,
          retryable: status === 429 || (status === 403 && rateLimitReason),
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
