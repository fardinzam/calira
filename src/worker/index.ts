import { access } from "node:fs/promises";

async function main() {
  for (const name of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_TOKEN_FILE",
  ] as const) {
    if (!process.env[name]) {
      throw new Error(`Missing ${name}`);
    }
  }

  try {
    await access(process.env.GOOGLE_TOKEN_FILE!);
  } catch {
    throw new Error("GOOGLE_TOKEN_FILE is not readable");
  }

  throw new Error("Forms polling is not implemented until Task 4");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Worker failed");
  process.exitCode = 1;
});
