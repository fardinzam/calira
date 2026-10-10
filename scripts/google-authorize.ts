import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { googleConfig } from "../src/lib/google/auth";

const scopes = [
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/forms.body.readonly",
];
const redirectUri = "http://127.0.0.1:8765/oauth2callback";

async function main(): Promise<void> {
  const { clientId, clientSecret, tokenFile } = googleConfig();
  const secretsDir = resolve(".secrets");
  const destination = resolve(tokenFile);
  const withinSecrets = relative(secretsDir, destination);
  if (
    !withinSecrets ||
    withinSecrets === ".." ||
    withinSecrets.startsWith(`..${sep}`)
  ) {
    throw new Error("GOOGLE_TOKEN_FILE must be inside .secrets/");
  }

  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  const state = randomBytes(32).toString("hex");
  const server = createServer();
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once("error", rejectListening);
      server.listen(8765, "127.0.0.1", resolveListening);
    });
    const code = new Promise<string>((resolveCode, rejectCode) => {
      const timeout = setTimeout(
        () => rejectCode(new Error("Authorization timed out")),
        5 * 60_000,
      );
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", redirectUri);
        if (url.pathname !== "/oauth2callback") {
          response.writeHead(404).end();
          return;
        }
        if (url.searchParams.get("state") !== state) {
          response.writeHead(400).end("Invalid authorization state");
          return;
        }
        const authorizationCode = url.searchParams.get("code");
        if (!authorizationCode) {
          response.writeHead(400).end("Authorization was not granted");
          clearTimeout(timeout);
          rejectCode(new Error("Authorization was not granted"));
          return;
        }
        response
          .writeHead(200, { "Content-Type": "text/plain" })
          .end("Authorization received. Return to the terminal.");
        clearTimeout(timeout);
        resolveCode(authorizationCode);
      });
    });

    console.log(
      "Open this URL in your browser and authorize the owner account:",
    );
    console.log(
      client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: scopes,
        state,
      }),
    );
    const { tokens } = await client.getToken(await code);
    if (!tokens.refresh_token)
      throw new Error("Google did not return a refresh token");

    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(tokens), {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new Error("Could not write GOOGLE_TOKEN_FILE");
    }
    console.log("Google authorization saved in GOOGLE_TOKEN_FILE");
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error &&
      [
        "Authorization timed out",
        "Authorization was not granted",
        "Google did not return a refresh token",
        "Could not write GOOGLE_TOKEN_FILE",
        "GOOGLE_TOKEN_FILE must be inside .secrets/",
      ].includes(error.message)
      ? error.message
      : "Google authorization failed; check client settings and the local redirect URI",
  );
  process.exitCode = 1;
});
