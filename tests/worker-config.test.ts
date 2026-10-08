import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("worker:once names a missing Google secret without printing its value", () => {
  const env = { ...process.env };
  delete env.GOOGLE_CLIENT_ID;
  env.GOOGLE_CLIENT_SECRET = "fixture-client-secret-value";
  delete env.GOOGLE_TOKEN_FILE;

  const result = spawnSync(process.execPath, ["--import", "tsx", "src/worker/index.ts", "--once"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing GOOGLE_CLIENT_ID/);
  assert.doesNotMatch(result.stderr, /fixture-client-secret-value/);
});
