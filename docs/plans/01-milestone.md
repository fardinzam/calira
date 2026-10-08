# Milestone 01 — Forms Ingestion and Run Visibility

> **Execution rule:** This is a plan for review, not authorization to start coding. When execution begins, complete tasks in order, update the progress boxes, and stop after code-writing work for the owner's manual review. Do not stage, commit, or push unless explicitly instructed.

**Goal:** A single owner can configure one Google Form, enable polling, submit a response, and see exactly one durable run for that response in the web app. This milestone detects work; later milestones execute Filter, Calendar, and Gmail steps.

**Architecture:** A Next.js app saves one workflow and displays detected runs. A separate Node worker calls `forms.responses.list`, follows every page, and stores unseen response IDs and a durable cursor in PostgreSQL. Both processes use the same TypeScript codebase and database. The worker does not create Calendar events or send email in this milestone.

**Tech stack:** TypeScript, Next.js/React, Tailwind, PostgreSQL, Node worker, and the official `googleapis` Node package. For this milestone, use `pg` for the few SQL operations and `tsx --test` for TypeScript tests; avoid an ORM and a queue. Exact package versions are selected when scaffolding and recorded in the lockfile.

**Sources:** [product.md](../product.md), [architecture.md](../architecture.md), and [decisions.md](../decisions.md). Google API behavior: [list Form responses](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list) and [response fields](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses).

## Exact deliverable and limits

- One locally runnable app with a simple workflow setup page (name and Form ID), enable/disable control, and a home page listing detected runs and their response IDs/timestamps.
- One locally runnable worker that polls enabled workflows and persists each newly submitted Form response once, including the answer snapshot needed by later milestones.
- A single developer-owned Google account authorized to read the reference Form. A local OAuth bootstrap writes credentials to `.secrets/google-token.json` with owner-only permissions; `.secrets/` is ignored by Git and its contents are never returned to the browser.
- A successful integration demonstration: submit to the reference Form, poll, see one `queued` run, restart the web app and worker, poll again, and still see one run.
- No Calendar, Gmail, Filter execution, generic field mapping, app login, public deployment, or polished landing page in this milestone.

## Progress

- [x] Task 1: Scaffold app, database, and test setup.
- [x] Task 2: Add workflow save/enable/disable behavior and durable schema.
- [ ] Task 3: Add Google authorization bootstrap and Forms response client.
- [ ] Task 4: Add the Forms polling worker with pagination and deduplication.
- [ ] Task 5: Add the setup and run-list interface.
- [ ] Task 6: Run the end-to-end acceptance check and update this file with results.

Mark a task complete only after its listed tests pass and its code has been manually reviewed. Record progress and any changed decision under **Progress notes** below. Future milestones get separate files.

## Task interfaces and likely files

These paths describe responsibilities, not a required framework-generated file tree. Follow the generated Next.js convention if scaffolding uses `app/` rather than `src/app/`.

| Boundary             | Contract                                                                                                                                                              | Likely files                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Workflow persistence | `saveWorkflow(input)`, `setWorkflowEnabled(id, enabled, now)`, `listWorkflows()`; enabling sets `enabled_at` and poll cursor to `now`.                                | `src/lib/db.ts`, `src/lib/workflows.ts`, `db/001_init.sql`                                                    |
| Run persistence      | `insertRunIfAbsent(workflowId, response)` uses unique `(workflow_id, response_id)` and returns whether it inserted; `listRuns()` is read-only.                        | `src/lib/runs.ts`, `db/001_init.sql`                                                                          |
| Forms client         | `listFormResponses(formId, since, pageToken?)` returns `{ responses, nextPageToken }`; a response has `responseId`, `createTime`, `lastSubmittedTime`, and `answers`. | `src/lib/google/forms.ts`, `scripts/google-authorize.ts`                                                      |
| Poller               | `pollWorkflow(workflowId, formsClient, db)` fetches every page, saves eligible unseen responses, then advances the cursor. A failed fetch never advances it.          | `src/worker/poll-forms.ts`, `src/worker/index.ts`                                                             |
| Web UI               | Setup posts only name/Form ID and enable state; run list reads persisted rows. No Google credential is exposed in HTML or API responses.                              | `src/app/page.tsx`, `src/app/workflows/new/page.tsx`, `src/app/workflows/actions.ts`, `src/app/runs/page.tsx` |

The database contains `workflow(id, name, form_id, enabled, enabled_at, created_at, updated_at)`, `form_poll_state(workflow_id, cursor_at, last_checked_at, last_error)`, and `run(id, workflow_id, response_id, create_time, last_submitted_time, answers_json, state, created_at)`. `run` has a unique constraint on `(workflow_id, response_id)` and starts in `queued`. This milestone does not create `step_run`; that table arrives with action execution. The later executor consumes `run.answers_json` and a workflow configuration snapshot added when action configuration exists.

## Task order and ownership

**Task 1 — Scaffold and database (primary agent).** Create the Next.js TypeScript/Tailwind app in this folder, install only the dependencies required above, add `.gitignore` (including `.secrets/`) and `.env.example`, and create `db/001_init.sql`. Define `DATABASE_URL`, `TEST_DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_TOKEN_FILE` in `.env.example` without values. Add package scripts `db:migrate`, `test`, `worker:once`, and `worker` (continuous polling); `worker:once` is the deterministic integration command. Use the user's local PostgreSQL instance or a disposable test database; do not add Docker solely for this milestone. Test that `npm run db:migrate` applies cleanly to an empty database and that `npm run worker:once` reports a missing secret by variable name without printing its value. Review gate: the owner can inspect the scaffold and migration before more code is written.

**Task 2 — Workflow and run persistence (primary agent).** Implement the persistence contracts in the table. Validate nonempty workflow name and Form ID at save time. On enable/re-enable, set `enabled_at` and `cursor_at` to the injected `now`; disabled workflows cannot be selected for polling. Put the database tests in `tests/workflows.test.ts` and `tests/runs.test.ts`. Run `npm test` and confirm unique response insertion, enable baseline, re-enable baseline, and persistence across a new database connection. Review gate: the owner checks schema and baseline behavior.

**Task 3 — Google access and Forms client (Forms subagent).** Implement `scripts/google-authorize.ts` for a local OAuth authorization-code flow using the developer's Google client ID/secret and only `forms.responses.readonly`. Write the resulting token JSON to `GOOGLE_TOKEN_FILE` under `.secrets/` with file mode `0600`; do not print tokens. The worker reads that file and refreshes access as needed. Implement `listFormResponses` with the API's `timestamp >=` filter and page token. Put request/normalization tests in `tests/forms-client.test.ts`, run `npm test`, then run one owner-account smoke check against the reference Form once credentials exist. Review gate: the owner checks requested scope and secret handling.

**Task 4 — Polling worker (Forms subagent).** Use the Task 2 persistence contract and Task 3 client. For each enabled workflow, claim a per-workflow PostgreSQL advisory lock so two polls cannot advance the same cursor concurrently. Fetch every page and discard responses whose `createTime` is before `enabled_at`. At the final persistence transaction, lock the workflow row and recheck that it is still enabled with the same `enabled_at` baseline used for the fetch; if not, insert nothing and leave the newer cursor intact. This row lock coordinates with `setWorkflowEnabled`. Insert unseen response IDs and advance `cursor_at` to the greatest processed `lastSubmittedTime` in that transaction; use an inclusive next query so ties are safe. Leave the cursor unchanged after any page/API/database failure. Release the advisory lock even on error. Put polling tests in `tests/poll-forms.test.ts`; run `npm test` and cover two responses at the same timestamp, multiple pages, repeat polling, an edited old response, a failure on page two, a disabled workflow, and restart using the persisted cursor. Review gate: the owner checks that all failure paths leave a recoverable cursor.

**Task 5 — Setup and run list (UI subagent).** Use only Task 2 persistence calls. Provide a plain workflow setup page and enable/disable control; show the current state and Form ID. Show recent run IDs, response IDs, submission times, and `queued` state on the home/run page. Show a basic empty state and a save error. Do not put Google secrets in client components, form fields, or serialized responses. Put UI/server-boundary tests in `tests/workflow-ui.test.ts`; run `npm test` and cover save validation, enable/disable, empty state, and rendering of a detected run. Review gate: the owner checks the visible flow and that it does not imply actions have executed.

**Task 6 — Integration and milestone acceptance (primary agent).** Apply the migration to a fresh database, configure the reference Form, submit one new response, run the poller, and confirm one `queued` run is visible. Poll again and confirm the count remains one. Restart web and worker, submit another response, poll, and confirm a second run appears. Disable, submit a response, poll, and confirm no new run; re-enable and confirm the disabled-period response is not backfilled. Run the automated test suite. Write the exact commands, outcomes, and any limitations under **Progress notes**. Stop for the owner's review; take no version control action.

## Acceptance tests

1. **New response:** A newly submitted response to the configured Form appears once as a `queued` run in the UI after polling.
2. **Duplicate and ties:** Repeated polls and two responses with equal `lastSubmittedTime` preserve one run per distinct `responseId`.
3. **Pagination:** More than one response page is ingested before the cursor moves.
4. **Failure recovery:** An API failure on a later page does not advance the cursor; a subsequent poll ingests all unseen responses without duplicates.
5. **Edits and disable:** An old edited response does not become a new run; disabled workflows create no runs, including for submissions made during the disabled interval after re-enable.
6. **Restart:** New responses are still detected after both processes restart, and previous runs remain visible.
7. **Credentials:** The browser receives no Google client secret or refresh token, and missing/revoked credentials produce a safe error rather than a fabricated successful poll.

## Subagent ownership

This section assigns work if the owner chooses to delegate implementation; it does not start subagents now. The primary agent owns the schema, persistence interfaces, integration, acceptance checks, and cross-file decisions. The **Forms subagent** owns only Google authorization bootstrap, Forms client, and polling worker (Tasks 3–4); it must use the Task 2 contracts and must not edit UI files. The **UI subagent** owns only setup/run views and their tests (Task 5); it must use the Task 2 contracts and must not edit worker, Google credential, or migration files. Each subagent reports its tests and limitations to the primary agent. Shared-file conflicts go to the primary agent for resolution. Manual review remains required after code-writing work.

## Progress notes

- 2026-10-06: Plan written; no implementation started. Exact reference Form ID and developer credentials are supplied at execution time as secrets, not entered in this document.
- 2026-10-08: Task 1 scaffold and lockfile written. `automator_m01_test` had zero public tables before `PGPASSFILE="$PWD/.secrets/pgpass" DATABASE_URL='postgresql://postgres@localhost:5432/automator_m01_test' npm run db:migrate` exited 0. Schema inspection found `workflow`, `form_poll_state`, and `run`, including `UNIQUE (workflow_id, response_id)` and a `queued` default. `npm test` passed one worker configuration test; `npm run build` passed. With Google variables unset, `npm run worker:once` exited 1 with `Missing GOOGLE_CLIENT_ID` and no value. The `pg` client printed a `pgpass` deprecation warning. Separate reviewer findings were addressed; owner manual review is pending, so Task 1 remains unchecked.
- 2026-10-08: Owner pushed Task 1 and explicitly proceeded to Task 2, satisfying its manual review gate. Task 2 adds `saveWorkflow(input, db?)`, `setWorkflowEnabled(id, enabled, now, db?)`, `listWorkflows(db?)`, `listEnabledWorkflows(db?)`, `insertRunIfAbsent(workflowId, response, db?)`, and `listRuns(db?)`; optional `db` is a `pg.Pool`, with the configured pool used by default. Against `automator_m01_test`, `npm test` passed 5 tests covering validation, enable/re-enable baselines, disabled polling selection, deduplication, and persistence after reconnect. `npm run build` and `npx tsc --noEmit` passed. The `pg` client printed its `pgpass` deprecation warning. Separate review found no Task 2 defect; it identified the enable/poll race now specified in Task 4 above. Task 2 awaits owner manual review and remains unchecked.
- 2026-10-08: Owner committed and pushed Task 2, then explicitly proceeded to Task 3, satisfying its manual review gate. The Forms subagent added the local OAuth bootstrap and Forms response client. The client preserves the Task 2 `FormResponse` contract, uses an inclusive timestamp filter and page token, and labels revoked authorization as requiring reconnection. Against `automator_m01_test`, `npm test` passed 11 tests; `npm run build` and `npx tsc --noEmit` passed. A live owner-account smoke check was not run: no Google credentials, token file, or reference Form ID are available in this workspace. Task 3 awaits owner manual review and the live check, so it remains unchecked.
