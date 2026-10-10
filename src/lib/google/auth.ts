import { readFile } from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";

export const googleScopes = [
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/gmail.send",
];

export function getGoogleSenderEmail(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env.GOOGLE_SENDER_EMAIL?.trim();
  if (!value) throw new Error("Missing GOOGLE_SENDER_EMAIL");
  if (
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("Invalid GOOGLE_SENDER_EMAIL");
  }
  return value;
}

export function googleConfig(): {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
} {
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_TOKEN_FILE",
  ] as const) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  return {
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    tokenFile: process.env.GOOGLE_TOKEN_FILE!,
  };
}

export async function getGoogleAuth(): Promise<OAuth2Client> {
  const { clientId, clientSecret, tokenFile } = googleConfig();
  let token: unknown;
  try {
    token = JSON.parse(await readFile(tokenFile, "utf8"));
  } catch {
    throw new Error(
      "GOOGLE_TOKEN_FILE is missing or invalid; run the local authorization script",
    );
  }
  if (
    !token ||
    typeof token !== "object" ||
    typeof (token as { refresh_token?: unknown }).refresh_token !== "string" ||
    !(token as { refresh_token: string }).refresh_token
  ) {
    throw new Error(
      "GOOGLE_TOKEN_FILE has no refresh token; run the local authorization script",
    );
  }

  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({
    refresh_token: (token as { refresh_token: string }).refresh_token,
  });
  return client;
}
