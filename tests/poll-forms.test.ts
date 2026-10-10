import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import type { FormResponse } from "../src/lib/runs";
import {
  saveWorkflow,
  setWorkflowEnabled,
  updateWorkflow,
} from "../src/lib/workflows";
import { pollEnabledWorkflows, pollWorkflow } from "../src/worker/poll-forms";
import { config, metadataFor } from "./workflow-fixtures";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("Missing TEST_DATABASE_URL");
const db = new Pool({ connectionString });
after(() => db.end());

const baseline = new Date("2026-10-08T10:00:00.000Z");
const at = (minute: number) =>
  new Date(baseline.getTime() + minute * 60_000).toISOString();
const response = (
  id: string,
  minute: number,
  createdMinute = minute,
): FormResponse => ({
  responseId: id,
  createTime: at(createdMinute),
  lastSubmittedTime: at(minute),
  answers: {},
});

async function withWorkflow(
  body: (id: string) => Promise<void>,
  enabled = true,
) {
  const workflow = await saveWorkflow(
    { name: "Polling test", formId: "form-test", config },
    db,
    metadataFor("form-test"),
  );
  try {
    if (enabled) {
      await setWorkflowEnabled(
        workflow.id,
        true,
        baseline,
        db,
        metadataFor("form-test"),
      );
    }
    await body(workflow.id);
  } finally {
    await db.query("DELETE FROM workflow WHERE id = $1", [workflow.id]);
  }
}

async function state(id: string) {
  const [runs, poll] = await Promise.all([
    db.query<{ response_id: string }>(
      "SELECT response_id FROM run WHERE workflow_id = $1 ORDER BY response_id",
      [id],
    ),
    db.query<{ cursor_at: Date; last_checked_at: Date | null }>(
      "SELECT cursor_at, last_checked_at FROM form_poll_state WHERE workflow_id = $1",
      [id],
    ),
  ]);
  return {
    ids: runs.rows.map((row) => row.response_id),
    cursor: poll.rows[0].cursor_at?.toISOString(),
    checked: poll.rows[0].last_checked_at,
  };
}

test("ingests all pages with one inclusive cursor and preserves equal timestamps", async () => {
  await withWorkflow(async (id) => {
    const requests: Array<{ since: string; token?: string }> = [];
    const forms = {
      async listFormResponses(_formId: string, since: Date, token?: string) {
        requests.push({ since: since.toISOString(), token });
        return token
          ? { responses: [response("second", 2)] }
          : { responses: [response("first", 2)], nextPageToken: "page-2" };
      },
    };
    await pollWorkflow(id, forms, db);
    assert.deepEqual((await state(id)).ids, ["first", "second"]);
    assert.equal((await state(id)).cursor, at(2));
    assert.ok((await state(id)).checked);
    assert.deepEqual(requests, [
      { since: at(0), token: undefined },
      { since: at(0), token: "page-2" },
    ]);

    await pollWorkflow(id, forms, db);
    assert.deepEqual((await state(id)).ids, ["first", "second"]);
    assert.equal(requests[2].since, at(2));
  });
});

test("ignores an edited response created before enablement", async () => {
  await withWorkflow(async (id) => {
    await pollWorkflow(
      id,
      {
        async listFormResponses() {
          return { responses: [response("old", 5, -1), response("new", 3)] };
        },
      },
      db,
    );
    assert.deepEqual((await state(id)).ids, ["new"]);
    assert.equal((await state(id)).cursor, at(5));
  });
});

test("a later page failure leaves the cursor and batch unchanged, then recovers", async () => {
  await withWorkflow(async (id) => {
    let fail = true;
    const forms = {
      async listFormResponses(_formId: string, _since: Date, token?: string) {
        if (token && fail) throw new Error("page failed");
        return token
          ? { responses: [response("second", 2)] }
          : { responses: [response("first", 1)], nextPageToken: "page-2" };
      },
    };
    await assert.rejects(pollWorkflow(id, forms, db), /page failed/);
    assert.deepEqual(await state(id), {
      ids: [],
      cursor: at(0),
      checked: null,
    });
    fail = false;
    await pollWorkflow(id, forms, db);
    assert.deepEqual((await state(id)).ids, ["first", "second"]);
    assert.equal((await state(id)).cursor, at(2));
  });
});

test("a persistence error rolls back earlier inserts and cursor movement", async () => {
  await withWorkflow(async (id) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      pollWorkflow(
        id,
        {
          async listFormResponses() {
            return {
              responses: [
                response("first", 1),
                { ...response("bad", 2), answers: cyclic },
              ],
            };
          },
        },
        db,
      ),
    );
    assert.deepEqual(await state(id), {
      ids: [],
      cursor: at(0),
      checked: null,
    });
  });
});

test("disabled workflows do not call Forms or create runs", async () => {
  await withWorkflow(async (id) => {
    await pollWorkflow(
      id,
      {
        async listFormResponses() {
          throw new Error("Forms should not be called");
        },
      },
      db,
    );
    assert.deepEqual(await state(id), {
      ids: [],
      cursor: undefined,
      checked: null,
    });
  }, false);
});

test("a new connection resumes from the persisted cursor", async () => {
  await withWorkflow(async (id) => {
    await pollWorkflow(
      id,
      {
        async listFormResponses() {
          return { responses: [response("first", 2)] };
        },
      },
      db,
    );
    const reopened = new Pool({ connectionString });
    try {
      await pollWorkflow(
        id,
        {
          async listFormResponses(_formId, since) {
            assert.equal(since.toISOString(), at(2));
            return { responses: [response("first", 2), response("second", 3)] };
          },
        },
        reopened,
      );
    } finally {
      await reopened.end();
    }
    assert.deepEqual((await state(id)).ids, ["first", "second"]);
    assert.equal((await state(id)).cursor, at(3));
  });
});

test("disable and re-enable during fetch discard the old baseline", async () => {
  await withWorkflow(async (id) => {
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const polling = pollWorkflow(
      id,
      {
        async listFormResponses() {
          fetchStarted();
          await resume;
          return { responses: [response("stale", 1)] };
        },
      },
      db,
    );
    await fetching;
    await setWorkflowEnabled(id, false, new Date(at(2)), db);
    await setWorkflowEnabled(
      id,
      true,
      new Date(at(3)),
      db,
      metadataFor("form-test"),
    );
    releaseFetch();
    await polling;
    assert.deepEqual(await state(id), {
      ids: [],
      cursor: at(3),
      checked: null,
    });
  });
});

test("a concurrent poll skips a workflow already being fetched", async () => {
  await withWorkflow(async (id) => {
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const first = pollWorkflow(
      id,
      {
        async listFormResponses() {
          fetchStarted();
          await resume;
          return { responses: [response("first", 1)] };
        },
      },
      db,
    );
    await fetching;
    await pollWorkflow(
      id,
      {
        async listFormResponses() {
          throw new Error("Concurrent Forms fetch should not start");
        },
      },
      db,
    );
    releaseFetch();
    await first;
    assert.deepEqual((await state(id)).ids, ["first"]);
  });
});

test("a failed workflow does not prevent the next enabled workflow from polling", async () => {
  const failing = await saveWorkflow(
    { name: "Failing poll", formId: "form-failing-cycle", config },
    db,
    metadataFor("form-failing-cycle"),
  );
  const succeeding = await saveWorkflow(
    { name: "Succeeding poll", formId: "form-succeeding-cycle", config },
    db,
    metadataFor("form-succeeding-cycle"),
  );
  try {
    await setWorkflowEnabled(
      failing.id,
      true,
      baseline,
      db,
      metadataFor("form-failing-cycle"),
    );
    await setWorkflowEnabled(
      succeeding.id,
      true,
      baseline,
      db,
      metadataFor("form-succeeding-cycle"),
    );
    await db.query("UPDATE workflow SET created_at = $2 WHERE id = $1", [
      failing.id,
      at(2),
    ]);
    await db.query("UPDATE workflow SET created_at = $2 WHERE id = $1", [
      succeeding.id,
      at(1),
    ]);
    const forms = {
      async listFormResponses(formId: string) {
        if (formId === "form-failing-cycle") throw new Error("page failed");
        return {
          responses:
            formId === "form-succeeding-cycle"
              ? [response("succeeded-after-failure", 1)]
              : [],
        };
      },
    };

    assert.equal(await pollEnabledWorkflows(forms, db), "Forms polling failed");
    assert.deepEqual((await state(failing.id)).ids, []);
    assert.equal((await state(failing.id)).cursor, at(0));
    assert.deepEqual((await state(succeeding.id)).ids, [
      "succeeded-after-failure",
    ]);
  } finally {
    await db.query("DELETE FROM workflow WHERE id IN ($1, $2)", [
      failing.id,
      succeeding.id,
    ]);
  }
});

test("revoked authorization yields a safe reconnect instruction for the cycle", async () => {
  await withWorkflow(async (id) => {
    assert.equal(
      await pollEnabledWorkflows(
        {
          async listFormResponses() {
            throw new Error(
              "Google authorization expired or revoked; reconnect the owner account",
            );
          },
        },
        db,
      ),
      "Google authorization expired or revoked; reconnect the owner account",
    );
    assert.equal((await state(id)).cursor, at(0));
  });
});

test("a run keeps its original configuration while a later run captures an edit", async () => {
  await withWorkflow(async (id) => {
    const forms = {
      async listFormResponses(_formId: string, since: Date) {
        return {
          responses:
            since.getTime() <= baseline.getTime()
              ? [response("before-edit", 1)]
              : [response("before-edit", 1), response("after-edit", 2)],
        };
      },
    };
    await pollWorkflow(id, forms, db);
    await updateWorkflow(
      id,
      {
        name: "Polling test",
        formId: "form-test",
        config: {
          ...config,
          gmail: { ...config.gmail, subject: "Updated subject" },
        },
      },
      db,
      metadataFor("form-test"),
    );
    await pollWorkflow(id, forms, db);
    const stored = await db.query<{
      response_id: string;
      config_snapshot: {
        formId: string;
        config: { gmail: { subject: string } };
      };
    }>(
      "SELECT response_id, config_snapshot FROM run WHERE workflow_id = $1 ORDER BY response_id",
      [id],
    );
    assert.deepEqual(
      stored.rows.map((row) => [
        row.response_id,
        row.config_snapshot.formId,
        row.config_snapshot.config.gmail.subject,
      ]),
      [
        ["after-edit", "form-test", "Updated subject"],
        ["before-edit", "form-test", "Request from {{name}}"],
      ],
    );
  });
});

test("an edit during page fetch is captured under the final row lock", async () => {
  await withWorkflow(async (id) => {
    let releaseFetch!: () => void;
    let fetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const polling = pollWorkflow(
      id,
      {
        async listFormResponses() {
          fetchStarted();
          await resume;
          return { responses: [response("concurrent-edit", 1)] };
        },
      },
      db,
    );
    await fetching;
    await updateWorkflow(
      id,
      {
        name: "Polling test",
        formId: "form-test",
        config: {
          ...config,
          gmail: { ...config.gmail, subject: "Edited during fetch" },
        },
      },
      db,
      metadataFor("form-test"),
    );
    releaseFetch();
    await polling;
    const stored = await db.query<{
      config_snapshot: { config: { gmail: { subject: string } } };
    }>("SELECT config_snapshot FROM run WHERE workflow_id = $1", [id]);
    assert.equal(
      stored.rows[0].config_snapshot.config.gmail.subject,
      "Edited during fetch",
    );
  });
});

test("changing a disabled workflow's Form leaves the recorded source Form unchanged", async () => {
  await withWorkflow(async (id) => {
    await pollWorkflow(
      id,
      {
        async listFormResponses() {
          return { responses: [response("old-form-response", 1)] };
        },
      },
      db,
    );
    await setWorkflowEnabled(id, false, new Date(at(2)), db);
    await updateWorkflow(
      id,
      { name: "Polling test", formId: "replacement-form" },
      db,
    );
    const stored = await db.query<{
      config_snapshot: { formId: string };
    }>("SELECT config_snapshot FROM run WHERE workflow_id = $1", [id]);
    assert.equal(stored.rows[0].config_snapshot.formId, "form-test");
  });
});
