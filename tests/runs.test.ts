import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import { insertRunIfAbsent, listRuns } from "../src/lib/runs";
import { saveWorkflow } from "../src/lib/workflows";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const db = new Pool({ connectionString });
after(() => db.end());

test("response IDs are unique per workflow and queued runs survive a new connection", async () => {
  const workflow = await saveWorkflow(
    { name: "Consultations", formId: "form-3" },
    db,
  );
  const response = {
    responseId: "response-1",
    createTime: "2026-10-08T10:00:00.000Z",
    lastSubmittedTime: "2026-10-08T10:00:00.000Z",
    answers: { question1: { textAnswers: { answers: [{ value: "Ava" }] } } },
  };
  try {
    assert.equal(await insertRunIfAbsent(workflow.id, response, db), true);
    assert.equal(await insertRunIfAbsent(workflow.id, response, db), false);
    assert.equal(
      await insertRunIfAbsent(
        workflow.id,
        { ...response, responseId: "response-2" },
        db,
      ),
      true,
    );

    const reopened = new Pool({ connectionString });
    try {
      const runs = (await listRuns(reopened)).filter(
        (run) => run.workflowId === workflow.id,
      );
      assert.equal(runs.length, 2);
      assert.deepEqual(
        new Set(runs.map((run) => run.responseId)),
        new Set(["response-1", "response-2"]),
      );
      assert.ok(runs.every((run) => run.state === "queued"));
      assert.deepEqual(
        runs.find((run) => run.responseId === "response-1")?.answers,
        response.answers,
      );
    } finally {
      await reopened.end();
    }
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [workflow.id]);
  }
});
