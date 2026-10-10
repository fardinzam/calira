# Milestone 03 — Working Automation Implementation Plan

> **For agentic workers:** Execute this plan task by task. The main agent owns the shared contracts, migrations, claiming, transactions, failure semantics, integration, and Git actions. Delegate only the bounded Calendar, Gmail, and run-detail UI tasks after their shared interfaces have passed main-agent and separate read-only review. Keep every checklist and evidence entry truthful.

**Git gate:** The owner approved this plan on 2026-10-10 and explicitly authorized reviewed incremental **local** commits without per-task owner review, resolving the earlier instruction conflict. Only the main agent may stage and commit after its own review, separate read-only critic approval, resolution of findings, required checks, and verification of the owner's configured Git identity. Subagents never take Git actions. Do not push or merge without explicit direction. Stop for the owner's final milestone review.

**Goal:** A new qualifying consultation response passes the saved equality Filter, creates one mapped Calendar event, sends one plain-text Gmail acknowledgement, and displays persisted step results. A nonqualifying response is recorded as filtered out without either action.

**Architecture:** The existing Forms poller continues to insert queued runs with immutable configuration snapshots. The same Node worker claims eligible runs from PostgreSQL, evaluates and validates the stored response, then calls Calendar and Gmail in that order; each state change is committed separately from external calls. A basic run detail page reads safe persisted results. Milestone 04 adds recovery and retries.

**Tech stack:** TypeScript, Next.js/React, Node worker, PostgreSQL with `pg`, Google APIs through `googleapis`, Temporal polyfill for unambiguous local time validation, and Nodemailer MailComposer for plain-text MIME construction.

**Authority:** [Product](../product.md), [architecture](../architecture.md), [roadmap](../roadmap.md), [decisions](../decisions.md), and the completed [Milestone 02 plan](02-milestone.md). This plan controls Milestone 03 implementation after owner approval.

## Global constraints and scope

- Keep the fixed Forms → equality Filter → Calendar → Gmail sequence. Use `run.config_snapshot` and `run.answers_json`, never the current workflow configuration, for execution. Runs with null snapshots remain detection history.
- A disabled workflow is ineligible for a new queued-run claim. A run already marked `running` continues after disable. Re-enabling may resume previously queued runs; Forms submissions made during disable are not backfilled.
- Validate the request type and every value needed for both actions before the first Google action. Missing or malformed required answers fail visibly; optional notes become empty text. A Filter mismatch stops as `filtered_out` without Calendar or Gmail.
- The event is a 60-minute consultation **request** in `America/Los_Angeles`, not a confirmed booking. Reject nonexistent or ambiguous local times. Do not add a Calendar attendee or check availability. The acknowledgement says the request was received, not confirmed.
- Persist only safe error codes/messages and Google action IDs. Do not show **real** Form answer contents, MIME messages, tokens, OAuth URLs, API response bodies, or credentials in logs, pages, test output, or progress notes. Synthetic fixtures may contain sentinel values for privacy assertions.
- No automatic retry, crash recovery/reclaim, Calendar reconciliation, Gmail-only manual retry, ambiguous-send workflow, branching, or exactly-once claim in this milestone. A Google call and a database commit cannot be atomic. A step left in `running` after an unconfirmed outcome is not claimed again by Milestone 03; Milestone 04 owns investigation and recovery.
- Use one developer-controlled Google account. No app accounts, public OAuth verification, new process, queue, generic workflow engine, or broad refactor.

**Documentation alignment:** The roadmap header still calls Milestone 02 “planned,” and the README still describes the Milestone 01 scaffold. The milestone sequence and scope in the roadmap are authoritative; those headers are stale status text. Update status copy during final integration, without changing scope. The architecture describes later recovery and uncertain states; its recovery procedure belongs to Milestone 04 under the roadmap. This milestone creates the durable boundary those later procedures need.

## Review focus

- Malformed or stale JSON in a stored snapshot: Task 3 must fail safely before actions; Task 7 must never fall back to today's workflow configuration.
- A selected Form question with zero or multiple text answers: Task 3 must reject required values rather than pick one silently.
- A spring gap or fall overlap in the provider's time zone: Task 3 must reject the requested local time before Calendar.
- Disable racing a queued claim: Task 2 must serialize against the workflow row; Task 7 must let an already claimed run finish.
- Google confirms an action but the returned ID is absent or differs from the reserved Calendar ID: Tasks 4 and 7 must not mark it successful or automatically replay it.

## Decisions and external prerequisites

The [decision log](../decisions.md) records the choices below. Official method documentation supports the required scopes: [Forms responses.list](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list), [Forms retrieval](https://developers.google.com/workspace/forms/api/guides/retrieve-forms-responses), [Calendar scope list](https://developers.google.com/workspace/calendar/api/auth), [Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Calendar events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get), and [Gmail messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

1. Keep `forms.responses.readonly` for polling and `forms.body.readonly` for question metadata. Add `calendar.events.owned` for event insert and later read-back on an **owner-owned** reference calendar. This is narrower than `calendar.events` and supports the existing `primary` Calendar choice. If the owner chooses a shared calendar, stop and revisit the scope choice; do not silently request broader access. Add `gmail.send` only for Gmail.
2. The workflow's saved `calendarId` identifies the target; `primary` means the authorized account's primary Calendar. The Gmail API uses `userId: "me"`. The owner sets `GOOGLE_SENDER_EMAIL` locally to that same authorized account's **primary** Gmail address; the worker validates it before Calendar. No alias or profile/settings API call is added merely to discover the sender, since those calls need extra scopes. The live recipient checks the actual From address. Do not put the sender address in workflow config or Git.
3. Use Nodemailer MailComposer **only to build** a UTF-8, text-only RFC-compatible message from validated From, single To, subject, and body; no SMTP transport, HTML, attachments, or custom MIME parser. Convert its Buffer to base64url for `users.messages.send`. This follows [Gmail's raw-message guide](https://developers.google.com/workspace/gmail/api/guides/sending) and [MailComposer's build API](https://nodemailer.com/extras/mailcomposer). Reject CR/LF in rendered header values and reject a non-single recipient before building.

**Owner actions, only when execution reaches live checks:** After Task 1 updates the local authorization script, run `node --env-file=.env.local --import tsx scripts/google-authorize.ts` from the project directory. Open its URL locally and consent with the same Form-owner account; wait for the local “authorization saved” message. Keep the URL, token, and credentials out of chat. Set `GOOGLE_SENDER_EMAIL` in the ignored `.env.local` to that account's primary Gmail address. Confirm that the existing `primary` Calendar is safe for a test event, or create a private Calendar under that same account in Google Calendar Settings and supply **only its Calendar ID**; save that ID in the test workflow. A Calendar API access role alone does not establish who created the calendar. Choose an inbox under your control as the Form's Email answer for the live qualifying submission; do not paste the address or answer contents into chat. Consent, a safe Calendar, and a safe recipient are prerequisites for live external-action checks, not for writing or unit-testing the code. Do not make live action calls until the owner confirms these resources.

## Shared execution contract — main agent freezes before delegation

**Database migration `003_run_execution.sql`:** add `run.started_at`, `run.finished_at`, and nullable safe `error_code`/`error_message`. Add `step_run` with `run_id`, fixed `step_name` (`filter`, `calendar`, `gmail`), `state` (`pending`, `running`, `succeeded`, `skipped`, `failed`, `uncertain` reserved for Milestone 04), `attempt_count`, start/end times, nullable safe error code/message, nullable short result summary, and nullable `external_id`. Use primary key `(run_id, step_name)`, a foreign key to `run`, nonnegative attempts, and checks for fixed names/states. Do not alter existing answers, snapshots, response identity, or poll cursor. The run's allowed new states are `queued`, `running`, `filtered_out`, `succeeded`, `failed`, and `partially_failed`. The migration runner records `003_run_execution` once and remains transactional/repeatable.

**Action types in `src/lib/run-execution.ts`:**

```ts
export type ActionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      certainty: "rejected" | "unknown";
      code: string;
      message: string;
    };

export type CalendarEventInput = {
  calendarId: string;
  eventId: string;
  title: string;
  description: string;
  startDateTime: string; // RFC3339 with explicit offset
  endDateTime: string; // RFC3339 with explicit offset
  timeZone: "America/Los_Angeles";
};
export type GmailMessageInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};
export type CalendarClient = {
  insertEvent(
    input: CalendarEventInput,
  ): Promise<ActionResult<{ eventId: string }>>;
};
export type GmailClient = {
  sendMessage(
    input: GmailMessageInput,
  ): Promise<ActionResult<{ messageId: string }>>;
};
export type RunDetail = {
  id: string;
  responseId: string;
  submittedAt: Date;
  state:
    | "queued"
    | "running"
    | "filtered_out"
    | "succeeded"
    | "failed"
    | "partially_failed";
  detectionOnly: boolean;
  error: { code: string; message: string } | null;
  steps: Array<{
    name: "filter" | "calendar" | "gmail";
    state:
      "pending" | "running" | "succeeded" | "skipped" | "failed" | "uncertain";
    attemptCount: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    summary: string | null;
    externalId: string | null;
    error: { code: string; message: string } | null;
  }>;
};
```

Only the main agent changes these types after review. A client marks `rejected` only for a confirmed Google rejection, such as validated HTTP 400/401/403/404; its message is a fixed safe summary. Transport failures, timeouts, 5xx, a Calendar ID collision, or a success response missing its required ID are `unknown`. No client retries. A returned success is not evidence that the email was delivered.

**Transaction boundary:** Claim the oldest `queued` run with non-null snapshot and an enabled workflow using one PostgreSQL transaction and `FOR UPDATE OF r, w SKIP LOCKED`; mark it `running` and create three pending step rows before releasing locks. The same workflow row lock used by enable/disable makes claim order well-defined. No Google call occurs inside a transaction. Mark the Filter result and full pre-action validation outcome before starting Calendar. Persist a deterministic, Google-valid Calendar ID from the run UUID (lowercase hex without hyphens, prefixed with `a`) together with `calendar: running` **before** insert; Google allows client-supplied base32hex IDs of 5–1024 characters but does not guarantee collision detection ([event ID rules](https://developers.google.com/workspace/calendar/api/v3/reference/events)). Commit Calendar `succeeded` and its confirmed ID before marking Gmail `running` and calling Gmail. Commit Gmail `succeeded` and its returned ID with run `succeeded`. For a definite Calendar rejection, mark Calendar/run `failed` and Gmail `skipped`. For a definite Gmail rejection after Calendar success, retain the event and mark Gmail `failed` and run `partially_failed`; Milestone 04 adds Gmail-only retry. For an unconfirmed call outcome or failed result commit, leave the durable step/run `running` with no automatic claim or replay. Never infer success merely from a reserved Calendar ID.

**Safe read boundary:** `getRunDetail(runId: string, db: Pool = getDb()): Promise<RunDetail | null>` returns the shape above in fixed step order. A queued run with a snapshot has no persisted step rows yet; the read function synthesizes three `pending` steps without writing to the database. Claimed runs use their persisted rows. Legacy null-snapshot runs return an empty step list and show detection history, not action-ready steps. The read never returns `answers_json`, tokens, raw Google errors, or rendered Gmail content to the UI. Display a reserved Calendar ID as “planned ID” unless its step is `succeeded`.

**Task graph:** Task 1 → Tasks 2 and 3 (main); Tasks 4 and 5 may be delegated independently after Task 1's contract review; Task 6 may be delegated after Task 2's read contract review; Task 7 waits for Tasks 2–5; Task 8 waits for Tasks 6–7. No dependent code starts before the required review gate.

## Task 1 — Main agent: migration, shared types, and authorization contract

**Depends on:** owner approval of this plan. **Owned files:** `db/003_run_execution.sql`, `scripts/db-migrate.ts`, `scripts/google-authorize.ts`, `src/lib/run-execution.ts` (types/contracts only at this stage), `src/lib/google/auth.ts`, `.env.example`, `package.json`, `package-lock.json`, `tests/migration.test.ts`, and a focused authorization/config test. No subagent edits them.

- [x] Write failing migration tests for a fresh schema and a populated Milestone 02 schema with queued and legacy null-snapshot runs; assert columns, fixed step constraints, preserved data, and harmless repeat migration.
- [x] Add `003_run_execution.sql` and runner version entry; run the focused migration tests until green.
- [x] Define the action/read types above; add only the shared error/result helpers needed by both Google clients. Install `@js-temporal/polyfill`, `nodemailer`, and its TypeScript types for the specified time/MIME handling; keep the lockfile current.
- [x] Extend the existing scope list with `calendar.events.owned` and `gmail.send` while retaining both Forms scopes. Add `GOOGLE_SENDER_EMAIL` to `.env.example` and a server-side validated reader that names the missing setting without printing its value. Test scope preservation and missing/invalid sender errors.
- [x] Run focused tests, `npx tsc --noEmit`, `npm run lint`, and `npm run build`. Review the exact exported types and schema against product/architecture before any delegation.

**Acceptance:** Old runs and poll history survive; new tables/states are usable; migration reruns safely; scopes are the four specified values; missing sender fails safely. **Review/commit gate:** a separate read-only critic checks schema upgrade, contract fit, scopes, and tests. Main agent resolves concrete findings, gets scoped re-review, approves, then alone may stage and locally commit only Task 1 files under the approved plan.

## Task 2 — Main agent: durable claim, transitions, and safe detail read

**Depends on:** Task 1 reviewed and integrated, with any commit governed by the resolved Git policy. **Owned files:** `src/lib/run-execution.ts`, `src/lib/runs.ts` only if the existing list needs state fields, `tests/run-execution.test.ts`, and focused run tests. No subagent edits these files.

- [x] Write failing database tests for two claimers racing, disabled workflow, null-snapshot legacy run, re-enable with queued runs, and disable after claim. Use disposable schemas; do not touch the Milestone 02 acceptance database.
- [x] Implement the single-row claim and fixed step rows. Claim locks the workflow and run, then commits `running` before returning the stored answers and snapshot to worker code. Old null-snapshot runs stay queued/detection-only.
- [x] Write failing transition tests for Filter mismatch, validation failure before action, Calendar rejection, Calendar success then Gmail rejection, and both successes. Assert step order, attempts, timestamps, safe summaries, IDs, and terminal run state in persisted rows.
- [x] Implement explicit transaction functions for those fixed transitions, with a pre-insert Calendar ID. Avoid a generic workflow transition framework. Implement `getRunDetail` with the safe read boundary above; test three synthesized pending steps for queued snapshot runs, no steps for legacy runs, and that answer sentinels cannot appear in either result.
- [x] Run focused tests, typecheck, lint, and build.

**Acceptance:** No disabled/null-snapshot claim; exactly one claimer wins; confirmed successful steps are never overwritten; Calendar success survives Gmail failure; read result contains no answers. **Review/commit gate:** separate read-only critic checks locking against `setWorkflowEnabled`, transaction order, SQL constraints, and tests; resolve/re-review before main-agent local commit under the approved plan. Freeze `getRunDetail` and the transition API for UI and executor tasks.

## Task 3 — Main agent: Filter and pre-action response validation

**Depends on:** Task 1's snapshot/action types; may proceed while Tasks 4–5 run in their own files. **Owned files:** `src/lib/response-mapping.ts` and `tests/response-mapping.test.ts`. No subagent edits them.

- [ ] Write failing tests using Google Forms' `answers[questionId].textAnswers.answers` shape. Require exactly one string for each selected required question; missing/empty/multiple/malformed values and corrupt snapshot fields are invalid. An absent optional notes answer maps to empty text. Do not log fixture values.
- [ ] Implement `evaluateFilter(answers: Record<string, unknown>, snapshot: RunConfigSnapshot): "matched" | "filtered_out"` with a safe validation error for a missing/malformed request-type answer. A valid different choice returns `filtered_out`.
- [ ] Implement `prepareActions(answers: Record<string, unknown>, snapshot: RunConfigSnapshot, senderEmail: string): { calendar: Omit<CalendarEventInput, "eventId">; gmail: GmailMessageInput }` only for a matched response. Validate nonblank single-line name; one syntactically valid recipient address without CR/LF, display name, or multiple addresses; strict `YYYY-MM-DD` and `HH:mm`; all selected values; sender; and rendered nonblank header/body. Replace only the finite placeholders already allowed by `WorkflowConfig`. Reject CR/LF introduced into the rendered subject.
- [ ] Convert the local date/time in `America/Los_Angeles` with Temporal's `disambiguation: "reject"` and strict overflow. Add 60 elapsed minutes and produce explicit-offset RFC3339 start/end values. Test ordinary date, month rollover, leap day, spring gap, fall overlap, malformed time, invalid email, and Unicode text. All failures occur before either client call.
- [ ] Run focused tests, typecheck, lint, and build.

**Acceptance:** Filter mismatch needs no action inputs; matching but invalid data cannot produce action inputs; valid mapping matches the Milestone 02 preview's fixed title, notes, recipient, and message fields. **Review/commit gate:** separate read-only critic checks Forms shape, date/time edge cases, safe templates, and scope; resolve/re-review before main-agent local commit under the approved plan.

## Task 4 — Calendar subagent: one event insert adapter

**Depends on:** Task 1 reviewed action types and OAuth choice. **Exact permitted files:** `src/lib/google/calendar.ts` and `tests/calendar.test.ts` only. **Interface:** export `calendarClient: CalendarClient` accepting `CalendarEventInput` from `src/lib/run-execution.ts`; its `insertEvent` calls `google.calendar({version:"v3", auth: await getGoogleAuth()}).events.insert` once and returns `ActionResult<{eventId:string}>`. No persistence, workflow decisions, retries, or other file edits.

- [x] Write mocked API tests for the configured Calendar ID, supplied stable event ID, fixed title/notes, offset start/end and zone, no attendees, returned ID, definite HTTP 400/403, transport/5xx unknown, and missing or mismatched response ID.
- [x] Implement the smallest adapter and safe error mapping. Never log the event body or raw API response.
- [x] Run focused tests, typecheck, lint, and scoped formatting.

**Reporting:** changed files, exact commands/results, safe API request fields tested, blockers, and limitations. **Review/commit gate:** separate read-only critic checks adapter scope and tests against this plan/product/architecture; subagent fixes concrete findings within its files and receives scoped re-review. Main agent integrates and alone stages/locally commits under the approved plan.

## Task 5 — Gmail subagent: plain-text send adapter

**Depends on:** Task 1 reviewed action types, installed MailComposer dependency, and OAuth choice. **Exact permitted files:** `src/lib/google/gmail.ts` and `tests/gmail.test.ts` only. **Interface:** export `gmailClient: GmailClient`; its `sendMessage` accepts validated `GmailMessageInput`, returns `ActionResult<{messageId:string}>`, and calls `users.messages.send` once with `userId:"me"` and base64url `raw`. No persistence, retry logic, workflow or package edits.

- [ ] Write mocked tests that decode the outgoing raw message without printing it: one From, one To, subject, UTF-8 plain-text body, no HTML/attachment/extra recipient, Gmail response ID, definite HTTP 400/403, transport/5xx unknown, and missing ID. Include CR/LF header-input rejection as defense in depth.
- [ ] Build with MailComposer `from`/`to`/`subject`/`text` only, disabled file/URL access, and no SMTP transport. Keep all raw MIME and tokens off logs and UI.
- [ ] Run focused tests, typecheck, lint, and scoped formatting.

**Reporting:** changed files, exact checks/results, safe message properties, blockers, and limitations. **Review/commit gate:** separate read-only critic checks Gmail scope, single-recipient plain-text construction, safe errors, and tests; subagent fixes within its files and gets scoped re-review. Main agent integrates and alone stages/locally commits under the approved plan.

## Task 6 — Run-detail UI subagent: safe status display

**Depends on:** Task 2's reviewed `getRunDetail` read contract; independent of Calendar/Gmail adapters. **Exact permitted files:** `src/app/runs/page.tsx`, `src/app/runs/run-list.tsx`, `src/app/runs/[id]/page.tsx`, `src/app/page.tsx` only for stale Milestone 02 action wording, and `tests/run-detail-ui.test.ts`. Do not edit shared SQL, executor, Google clients, or builder.

- [ ] Write UI tests for an empty run list, a link to each run, 404/missing run, a queued snapshot run with three pending steps, legacy detection history without action steps, filtered out, success with both external IDs, pre-action failure, Calendar failure, Calendar success/Gmail failure, and a running step. Use a synthetic sentinel answer/email body and assert it never renders.
- [ ] Render the three fixed steps in order with status, safe summary/error, timestamps, and confirmed IDs. Show a reserved but unconfirmed Calendar ID only as planned. State that Gmail `succeeded` means accepted for sending, not delivered. Show `partially_failed` without a retry control yet. Remove “actions begin in Milestone 03” copy once actions actually run.
- [ ] Run focused tests, typecheck, lint, and build. Report visible states or screenshots that contain only synthetic data.

**Reporting:** files, exact results, user-visible states, limitations/blockers. **Review/commit gate:** separate read-only critic checks privacy, wording, state fidelity, and tests; UI agent fixes within its files and gets scoped re-review. Main agent integrates and alone stages/locally commits under the approved plan.

## Task 7 — Main agent: ordered worker execution

**Depends on:** Tasks 2–5 reviewed and integrated. **Owned files:** `src/worker/execute-runs.ts`, `src/worker/index.ts`, `tests/execute-runs.test.ts`, and narrowly needed main-owned transition or mapping fixes. Do not edit delegated files without a bounded follow-up to their owner.

- [ ] Write failing tests with injected Calendar/Gmail clients and disposable DB: matching run calls Calendar then Gmail once; nonmatch calls neither; invalid answer/sender calls neither; definite Calendar rejection calls no Gmail; definite Gmail rejection leaves Calendar success and ID; disabled queued run is not claimed; a run claimed before disable finishes; legacy null-snapshot run is not executed; an unknown result is not replayed.
- [ ] Execute one claimed run from its stored snapshot/answers. Commit Filter and full pre-action validation results before Google calls. Persist Calendar `running` plus stable ID, call Calendar, commit success before Gmail `running`, then call Gmail and commit success. Use the Task 2 explicit transitions.
- [ ] Extend `worker:once` to poll once and drain eligible queued runs, then exit; extend the loop to poll and drain on its existing 60-second cycle. One run's definite failure must not block later runs. Keep logs safe and no in-process retry or new scheduler.
- [ ] Run focused tests, full suite, typecheck, lint, and build.

**Acceptance:** Exact order and durable step states; queued work pauses while disabled; already running work completes; no confirmed Calendar action is replayed by this worker. **Review/commit gate:** separate read-only critic checks action boundaries, failure branches, disabled race, and tests; resolve/re-review before main-agent local commit under the approved plan.

## Task 8 — Main agent: integration and live acceptance

**Depends on:** Tasks 1–7 reviewed and integrated, with any commits governed by the resolved Git policy. **Owned files:** `docs/plans/03-milestone.md` progress/evidence, plus narrowly required fixes in main-owned files. Delegate a fix in a subagent-owned file back to that implementer, then re-review. Preserve all unrelated working-tree changes.

- [ ] Migrate a fresh disposable DB and a disposable copy of a populated Milestone 02 schema; rerun the migration and verify old queued rows, null-snapshot legacy history, cursor, IDs, and timestamps survive. Do not use the old Milestone 02 acceptance DB for live execution: it contains queued test runs.
- [ ] Confirm the owner refreshed consent and identified the primary sender, a safe recipient, and a Calendar that is the account's `primary` or one the owner created under that account. Before any live action, use a read-only [Calendar events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) request for the chosen ID with `maxResults: 1` and a partial field selection for `accessRole`; require `owner` as a permission/scope preflight, **not** proof of calendar ownership. Do not print returned events. No credential, OAuth URL, token, or Form answer output.
- [ ] In a **fresh** acceptance DB, create/enable the existing six-question reference Form workflow after recording its new enable baseline. Use an owner-controlled Calendar (existing `primary` only if safe) and an acknowledgement that says “received” rather than “confirmed.” Ask the owner to submit one qualifying response with a safe requested time and one nonqualifying response, both **after** enablement; use a test inbox they control. Do not ask them to paste answers.
- [ ] Run `worker:once`. Verify by counts/booleans and browser UI: two distinct runs; qualifying run `succeeded` with Filter/Calendar/Gmail results, one confirmed event ID on the configured Calendar, one Gmail message ID, and a received plain-text acknowledgement from the primary sender; filtered run `filtered_out` with zero Calendar/Gmail calls or IDs. Re-poll and verify no extra run, event, or message. Have the owner confirm the received email and event details privately if API permissions do not allow reading them; never print answer contents. Validate a separate synthetic bad-value case and definite mocked API errors without creating live malformed Google actions.
- [ ] Exercise disable with queued work and an in-flight mocked run, plus safe run-detail states. Run `npm test` with `PGPASSWORD` limited to the test process, `npx tsc --noEmit`, `npm run lint`, `npm run build`, formatting, and `git diff --check`. Update stale status copy in `docs/roadmap.md` and `README.md` only if still stale when execution reaches this task.
- [ ] Have a separate final read-only critic review the integrated diff, plan, product, architecture, tests, and **actual** live evidence. Resolve findings and request scoped re-review. Apply the resolved Git gate above: check Git identity and exact staged files before any permitted local commit, or stop for manual review before staging. Stop for final owner review. Do not push or merge without explicit direction.

**Live result recording:** During execution record dates, command names, pass/fail counts, migration versions, run and step state counts, source-Form and configured-Calendar ID equality checks, returned-ID presence, browser states, reviewer findings/resolutions, and any unrun check. Do not record answer values, addresses, event descriptions, message content, token material, or full API responses. A successful API acknowledgement does not prove email delivery; owner inbox confirmation is separate evidence.

## Progress and evidence

- [x] Task 1 — migration, contract, and OAuth scopes; critic approved; committed locally
- [x] Task 2 — claims, transitions, and safe detail read; critic approved; committed locally
- [ ] Task 3 — Filter and pre-action validation; critic approved; local commit or owner review:
- [x] Task 4 — Calendar adapter; critic approved; committed locally
- [ ] Task 5 — Gmail adapter; critic approved; local commit or owner review:
- [ ] Task 6 — run-detail UI; critic approved; local commit or owner review:
- [ ] Task 7 — worker orchestration; critic approved; local commit or owner review:
- [ ] Task 8 — integration/live acceptance; final critic approved; local commit or owner review:

| Check                                      | Actual command or observation          | Result/date                             | Remaining issue |
| ------------------------------------------ | -------------------------------------- | --------------------------------------- | --------------- |
| Fresh and upgraded migration, repeat       | Task 1 migration tests                 | 3/3 passed, 2026-10-10                  |                 |
| Focused and full tests                     | Task 1 `npm test`; Task 2 focused/full | 65/65; 6/6 and 87/87 passed, 2026-10-10 |                 |
| Typecheck, lint, build, format, diff check | Tasks 1–2 named checks                 | Passed, 2026-10-10                      |                 |
| Consent and owner-controlled resources     |                                        | Pending                                 |                 |
| Qualifying live run and IDs                |                                        | Pending                                 |                 |
| Filtered live run, no action               |                                        | Pending                                 |                 |
| Re-poll duplicate check                    |                                        | Pending                                 |                 |
| Browser run detail and owner inbox check   |                                        | Pending                                 |                 |

| Task/reviewer | Concrete finding                                                                                          | Resolution and scoped re-review                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Task 1 critic | Sender accepted group/comment/control syntax                                                              | Failing-first cases added; stricter mailbox reader; scoped re-review approved, 2026-10-10  |
| Task 2 critic | Missing disable/claim race and intermediate boundary assertions; legacy detail could show artificial rows | Added lock race/boundary checks; legacy rows hidden; scoped re-review approved, 2026-10-10 |
| Task 4 critic | Google client could retry an insert despite one adapter call                                              | Disabled SDK retry and added option assertion; scoped re-review approved, 2026-10-10       |

## Final owner review gate

Present the completed milestone diff and any permitted local commits, exact tests and live checks actually run, all reviewer findings and fixes, remaining limitations, and the Milestone 04 recovery dependency. Stop for owner review. Do not begin Milestone 04, push, or merge until the owner directs it.
