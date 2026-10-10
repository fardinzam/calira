# Milestone 02 — Complete workflow configuration

**Status:** Implementation and live checks complete; awaiting owner milestone review. This plan implements [Milestone 02 in the roadmap](../roadmap.md). [Product](../product.md) controls user-visible behavior; [architecture](../architecture.md) controls technical design; [decisions](../decisions.md) records the reference choices. Milestone 01 is complete. Milestone 03 owns Filter execution and Calendar/Gmail calls.

## Reviewable result

The owner can create or edit one fixed Forms → equality Filter → Calendar → Gmail workflow through a plain step-by-step builder. The builder shows the selected Form questions, Calendar ID and provider time zone, Filter comparison, event mapping, and Gmail recipient, subject, and plain-text body. A complete configuration survives a web/worker restart and can be enabled or disabled. Incomplete or invalid configuration cannot be enabled. A preview shows what each mapping will produce using clearly marked example values. The home page explains the consultation-request use case and says action execution arrives in Milestone 03. Runs recorded after full configuration is saved carry an immutable configuration snapshot.

No Calendar or Gmail API action, Filter execution, retry, canvas, arbitrary expression, general-purpose template engine, or deployment work belongs to this milestone. `queued` still means detected, not executed.

## Reference contract and decisions

- The owner will use a **new consultation-request Form**, not the one-question Milestone 01 test Form. It has short-answer name and email questions, a multiple-choice request type with a `Consultation` choice, a Date question with year, a Time question, and an optional paragraph-answer notes question. Select the actual question IDs in the builder; do not hardcode test IDs. The first five questions are required; notes may be optional.
- Requested date and time are separate `YYYY-MM-DD` and `HH:mm` answer values from those native Google Forms Date and Time questions. The provider time zone is `America/Los_Angeles` and the event duration is 60 minutes. Display these values prominently in setup and preview. The builder saves the rule; Milestone 03 validates a particular response's date, time, and email before calling Google.
- The Calendar is selected by its Calendar ID, entered by the owner. No Calendar list or access test is implied by saving it; the first Calendar API call is in Milestone 03. The Gmail sender is the authorized account's primary address; the recipient is mapped to the email question, not entered as a fixed address.
- The Filter is one selected request-type question compared for exact equality with `Consultation`. The Calendar title uses the selected name, its start uses requested date/time, its end is 60 minutes later, and its description uses notes. The owner writes a plain-text Gmail subject and body. Support only documented placeholders for the selected answers (`{{name}}`, `{{requestType}}`, `{{requestedDate}}`, `{{requestedTime}}`, `{{notes}}`) in subject/body; reject unknown placeholders. This is a finite mapping for the reference flow, not an expression language.
- Milestone 01 `queued` runs without a configuration snapshot remain visible as detection history and must never be executed by the later worker. The migration disables an enabled legacy workflow that has no full configuration, because incomplete workflows cannot be enabled. It remains visible as incomplete; the owner can finish setup and re-enable. Existing response IDs, answers, timestamps, and cursor history are preserved. This migration policy is an explicit implementation decision in the decision log, not one of the owner's three reference-choice answers.
- Disabling a workflow stops polling and pauses claiming queued action-ready runs. A run already claimed continues. Re-enabling resets the polling baseline as in Milestone 01 and may resume queued runs recorded while the workflow was enabled. The executor itself is deferred to Milestone 03, but these semantics constrain the stored data and UI wording now.

### Persisted shape

The main agent fixes this interface before delegating implementation. Keep the editable config in one nullable `workflow.config_json` JSONB field; it may be an incomplete draft. At insertion, copy both the source `workflow.form_id` and the **validated complete** config into nullable `run.config_snapshot`. Null means a legacy/draft record, never an action-ready run. Keep existing `workflow.form_id` as the polling key. The completed config and recorded snapshot include:

```ts
type WorkflowConfig = {
  calendarId: string;
  timeZone: "America/Los_Angeles";
  questions: {
    name: string;
    email: string;
    requestType: string;
    requestedDate: string;
    requestedTime: string;
    notes: string;
  };
  filter: { equals: "Consultation" };
  gmail: { subject: string; body: string };
};

type RunConfigSnapshot = {
  formId: string;
  config: WorkflowConfig;
};
```

The fixed Calendar mapping, recipient mapping, and 60-minute duration come from this documented contract; do not store redundant editable variants. A config is complete only when every selected question ID is present, distinct, and matches the six question types above; Calendar ID and Gmail subject/body are nonblank; placeholders are from the finite list; and the request-type Form question includes `Consultation`. The **server** validates this when saving a complete config and again before enablement. Saving an incomplete draft is allowed; enabling it is not. Task 1 defines validation against trusted question metadata supplied by its caller and tests it with fixtures; Task 3 adds the live metadata fetch; Tasks 4–5 wire the fetch into server actions. The UI never certifies its own question types. The enable action fetches current metadata, and the enable transaction rechecks that the saved config is the same one that was validated. Editing a live workflow saves the new configuration for later runs without rewriting any existing `run.config_snapshot`. Make the current configuration visible after restart. Require disabling before changing the Form ID, and retain the original Form ID in every action-ready run snapshot.

### Form metadata and authorization

The builder needs Forms question titles, IDs, types, and choice options. Fetch these server-side with `forms.get`; the current token only grants `forms.responses.readonly`, so the local OAuth bootstrap must also request `forms.body.readonly`. Existing owner consent must be refreshed once. Never render a token or client secret, and do not put the OAuth URL or token file in this plan or test output. A Form ID can be pasted as in Milestone 01; fetching its metadata lets the owner select named questions. Give a safe reconnect/access error if metadata cannot be read. Preserve the response-list permission and existing polling behavior.

## Execution rules for this milestone

After each task's code and checks, the main agent and a separate read-only critic subagent review the result against this plan, product, architecture, and tests. The main agent resolves concrete findings and gets a scoped re-review. Only after both approve may the main agent stage and make the task's incremental **local** commit. Continue with dependent tasks without an owner review stop between tasks. Subagents take no Git actions. The owner reviews the completed milestone before Milestone 03 begins. Other `AGENTS.md` requirements remain: simple code, no silent interface decisions, owner Git identity, short lowercase plain-text commit messages, and no AI attribution. Do not push or merge. Preserve unrelated working-tree changes.

The main agent owns migrations, `WorkflowConfig`, validation, workflow/run persistence, polling snapshot integration, shared interfaces, final integration, and Git actions. Implementation subagents receive only the permitted files below and must report changed files, checks actually run, limitations, and blockers. A different critic reviewer examines each task against this plan, product, architecture, and tests; it makes no edits. The main agent assesses every concrete finding, fixes or delegates a bounded fix, reruns relevant checks, and stages or commits only after both reviews approve. Do not run dependent tasks until their contracts and prior review gates are complete. Parallel work is allowed only where the file ownership and interfaces below do not overlap.

Before any commit, inspect the diff and verify the configured Git author/committer match the owner's identity. Commit only milestone-owned files. Exclude unrelated working-tree files, including `next-env.d.ts` and `docs/plans/post-mvp-roadmap.md` if modified, from milestone commits.

## Tasks and dependencies

### Task 1 — Main agent: migration and shared configuration contract

**Depends on:** this approved plan and the new reference choices above. **Owns:** `db/002_workflow_config.sql`, `scripts/db-migrate.ts`, `src/lib/workflow-config.ts`, `src/lib/workflows.ts`, and focused migration/config/workflow tests. No subagent edits these files.

1. Add an incremental migration that upgrades an existing Milestone 01 database **and** creates the same final schema on an empty database. Keep old records. Add nullable config/snapshot columns and a minimal migration-version record so `npm run db:migrate` is safe on repeat. Recognize an already initialized Milestone 01 database without replaying `001_init.sql`. Disable legacy workflows that lack a full config; retain their cursor and runs. Make the migration transactional.
2. Define the shared `WorkflowConfig`, `RunConfigSnapshot`, reference question-type contract, and a narrow validation function. Validate trimmed IDs/text, distinct selected question IDs, known placeholders, required fields, the fixed zone/filter rule, and metadata-compatible question types/options. Avoid a generic schema or template framework. Make error messages safe for the UI.
3. Extend workflow persistence to save a draft or complete config, load one for editing, list current status, and enable/disable. The shared API accepts **caller-supplied trusted question metadata** for a complete save or enablement; Task 1 tests this with fixtures and does not call Google. The enable transaction rechecks that the validated config is still current before setting `enabled` and resetting the cursor. Tasks 4–5 must supply metadata fetched server-side by Task 3, never browser-supplied metadata. Reject Form ID changes while enabled. Preserve Milestone 01 polling and deduplication contracts.
4. Tests: migrate fresh and existing Milestone 01 schemas, rerun migration without data loss, preserve old runs, disable incomplete legacy workflows, reject invalid/incomplete enablement, enable a valid config, survive database reconnection, and reject an enabled Form-ID change. Use a disposable test database; never point a destructive test at the owner's acceptance database.

**Review/commit gate:** a separate critic checks the actual migration path, validation/transaction races, unnecessary abstractions, and test evidence. Main agent resolves findings, gets scoped re-review, approves the result, and stages/commits only after critic approval. The exact exported types/functions are then frozen for the Forms and UI assignments.

### Task 2 — Main agent: immutable run snapshots

**Depends on:** Task 1's committed schema and config interface. **Owns:** `src/lib/runs.ts`, `src/worker/poll-forms.ts`, and focused run/poll tests. No other implementer edits these files.

1. At the poller's final locked transaction, read the current workflow config together with Form ID, enabled flag, baseline, and cursor. Copy the source Form ID and current config into each newly inserted run in the **same transaction** as run insertion and cursor advancement. Keep the existing response-ID uniqueness and inclusive cursor behavior.
2. If workflow config changes while pages are being fetched, use the configuration protected by the final workflow row lock; if Form ID or baseline changed, discard that fetch as Milestone 01 already does. Do not retrofit or mutate previously inserted snapshots. Null snapshots stay null for legacy history.
3. Tests: edit after run insertion leaves earlier snapshot unchanged; a later response captures the new config; changing the Form ID while disabled does not change the original Form ID in earlier snapshots; duplicate polling does not replace a snapshot; a failed later page or database insert leaves cursor and runs recoverable; migration-era legacy runs stay null. Do not introduce the action executor.

**Review/commit gate:** a different critic checks snapshot timing and cursor atomicity against the architecture and existing polling tests. Main agent resolves findings, runs focused checks, gets scoped re-review, approves the result, and stages/commits only after critic approval.

### Task 3 — Forms subagent: question metadata and OAuth scope

**Depends on:** Task 1's reviewed question-type interface. May run alongside Task 2 because files do not overlap. **Permitted files:** `src/lib/google/form-metadata.ts`, `scripts/google-authorize.ts`, and `tests/form-metadata.test.ts` (plus a dedicated OAuth test file if needed). Do not edit migration, workflow/run persistence, polling, or UI files.

**Goal/interface:** export `getFormQuestions(formId)` using the existing server-side Google auth. Return only question ID, title, supported type, required flag, choice options, and the Date `includeYear`/`includeTime` and Time `duration` modes needed by the shared validator for the six reference roles. Map `includeYear` to the contract's `hasYear` field. Report unsupported types honestly; do not silently label them as text. Preserve response-list scope and request `forms.body.readonly` for metadata. Convert access/revocation failures into safe UI-facing errors.

**Acceptance checks:** mocked Forms API tests cover question extraction, choices, missing/unsupported items, and safe errors; TypeScript/build pass. A live metadata smoke check uses the new owner-controlled Form after consent is refreshed, reporting question count/types only, never answers, credentials, or token contents. If consent or the new Form is not yet ready, report the exact blocker and leave the live check for Task 6.

**Reporting/review/commit gate:** report files, commands/results, supported schema, and blockers. A separate critic checks scope minimization, server-only secret handling, and mapping fidelity. Main agent integrates fixes, gets scoped re-review, approves the result, and stages/commits only after critic approval.

### Task 4 — UI subagent: builder, editing, and preview

**Depends on:** Tasks 1 and 3 reviewed and integrated. **Permitted files:** `src/app/workflows/actions.ts`, `src/app/workflows/new/page.tsx`, `src/app/workflows/[id]/page.tsx`, builder components under `src/app/workflows/`, and `tests/workflow-ui.test.ts`. Do not edit shared persistence, Google, polling, home page, or run files.

**Goal/interface:** use only the frozen server persistence and `getFormQuestions` contracts. In server actions, fetch current Form metadata and pass it to the shared validator before a complete save; do not trust browser-supplied metadata. Provide a simple sequence: Form ID and question selection; fixed Filter; Calendar ID, time zone and event mapping; Gmail recipient mapping, subject and body; review/preview; save draft or complete workflow. Existing workflows open for editing. The preview uses clearly labeled sample values and shows the exact equality comparison, event title/start/end/description, and email recipient/subject/body. The preview makes no Google action call. Show required-field indicators, loading, empty Form, inaccessible Form, validation, and save errors. Render no secret or real response answer content.

**Acceptance checks:** UI/server-boundary tests cover valid creation/edit, incomplete draft, rejected invalid input, unsupported/missing question, placeholders, preview, and safe error states. Run `npm test`, typecheck, lint, and build, reporting actual results. Keep standard React/Next/Tailwind patterns; no general builder framework.

**Reporting/review/commit gate:** report files, commands/results, screenshots or visible-flow notes, and limitations. A separate critic checks the full review-before-enable information and product wording. Main agent resolves findings, integrates, gets scoped re-review, approves the result, and stages/commits only after critic approval.

### Task 5 — UI subagent: status, landing page, and enable flow

**Depends on:** Task 4 committed. This can use the same UI implementer after Task 4 review. **Permitted files:** `src/app/page.tsx`, `src/app/workflows/actions.ts`, existing builder/edit UI files only if needed, and `tests/workflow-ui.test.ts`. Do not edit shared persistence, Google, polling, or run files.

**Goal/interface:** the home page explains the narrow consultation-request flow and links to the builder/runs. Show each workflow's complete/incomplete and enabled/disabled state. Enable and disable from the reviewed configuration view or home page. The enable server action fetches current Form metadata and passes it to shared persistence validation; the transaction rechecks the config before enabling. State plainly that Calendar and Gmail execution are unavailable until Milestone 03, even when polling is enabled. Existing Milestone 01 runs remain visible as detected history; do not label them as action-ready.

**Acceptance checks:** tests cover no-workflow and save-error states, invalid enable rejection, visible enable/disable state after reload, edit link, and accurate milestone wording. Verify a complete workflow can be enabled and an incomplete legacy workflow cannot. Run focused tests, typecheck, lint, and build.

**Reporting/review/commit gate:** report files and exact results. A separate critic checks that UI labels match the persisted behavior and no action is implied. Main agent resolves findings, gets scoped re-review, approves the result, and stages/commits only after critic approval.

### Task 6 — Main agent: integration and milestone acceptance

**Depends on:** Tasks 1–5 committed locally and reviewed. **Owns:** integration checks and necessary fixes in task-owned files; `docs/plans/02-milestone.md` progress notes. If a fix touches a delegated file, give that implementer a precise bounded follow-up and review the result before committing.

1. Use separate disposable databases to prove migration from an empty schema and from a copy or fresh Milestone 01 schema with legacy workflow/run data. Confirm repeat migration is harmless. Never print credentials or answer contents.
2. Use the new six-question owner-controlled Form. Refresh local OAuth consent for the metadata scope and verify that the API returns the expected question IDs/types without logging answers. Confirm the builder maps them and rejects a wrong type or missing `Consultation` choice.
3. Save a full workflow with a chosen Calendar ID, sample-safe Gmail text, and the fixed zone/duration. Reload/restart the app and worker; confirm the config persists and enabling succeeds. Save an incomplete draft and confirm enable fails in the UI and server. Confirm enable/disable state and baseline behavior.
4. Submit one new response while enabled, poll once, and inspect the stored run's config snapshot **without displaying answer values**. Edit the workflow; inspect the earlier run snapshot and current config to prove they differ only where edited. Submit a second new response and confirm its new snapshot. Recheck that repeated polling creates no duplicate run and that legacy runs remain detection-only. Calendar and Gmail APIs must not be called.
5. Run `npm test` with `PGPASSWORD` only in the test process, `npx tsc --noEmit`, `npm run lint`, and `npm run build`. Perform a live browser pass through create/edit/preview/enable/disable and the home/run pages. Record commands, counts, observed states, and limitations below. Have a separate final critic check the integrated diff against this plan, product, architecture, and test evidence; resolve findings and get scoped re-review. After main-agent and critic approval, stage and commit final milestone-owned fixes/documentation. Then stop for the owner's milestone review.

**Owner gate:** present the completed milestone diff and local commit list, exact verification evidence, any remaining issues, and the proposed Milestone 03 dependency. Stop for owner review. Do not start Milestone 03, push, or merge until the owner directs it.

## Task progress

- [x] Task 1 — migration and shared configuration contract (`e66c955`; owner committed and pushed)
- [x] Task 2 — immutable run snapshots (reviewed and locally committed)
- [x] Task 3 — Form metadata and OAuth scope (reviewed and locally committed)
- [x] Task 4 — builder, editing, and preview (reviewed and locally committed)
- [x] Task 5 — status, landing page, and enable flow (reviewed and locally committed)
- [x] Task 6 — integration and milestone acceptance (reviewed; awaiting owner milestone review)

## Acceptance checklist

- [x] A new six-question reference Form and refreshed Forms metadata consent are available; metadata is shown by title and type without credentials or answers.
- [x] A complete fixed-order configuration persists through restart and can be enabled; a draft or invalid configuration cannot.
- [x] The review screen shows Filter equality, Calendar ID/time zone/title/start/end/notes, and Gmail recipient/subject/body before enablement.
- [x] Editing changes future runs only; an existing run's snapshot remains unchanged. Legacy Milestone 01 runs have no action-ready snapshot.
- [x] Enable/disable status and incomplete state are visible; disabled workflows are not polled, and the later executor's queued/running rule is recorded.
- [x] The landing page describes the consultation-request flow and accurately says actions begin in Milestone 03.
- [x] Focused tests, full test suite, typecheck, lint, build, migration checks, live Form metadata, and browser flow have recorded results. Any unrun check is marked pending rather than passed.
- [x] Each implementation task has main-agent and separate critic approval, findings disposition, and one incremental local commit; the owner reviews the milestone as a whole.

## Progress notes

- 2026-10-09: Detailed plan written after the owner chose the new consultation Form, Los Angeles time zone, 60-minute event, legacy detection history, and disable behavior. The plan also records the reference question types and the migration rule for incomplete enabled workflows. A separate document reviewer found gaps in question types, source Form snapshots, migration policy, and stale roadmap status; these were addressed. No Milestone 02 code or live check has started. The new Form and refreshed metadata consent are execution prerequisites.
- 2026-10-09: The owner restored the per-task manual-review gate after the planning commit; the execution rules above now reflect that instruction. Task 1 code is ready for owner review; it is not checked complete or committed. The main agent added the incremental migration, shared config/question metadata types and validator, draft/complete workflow persistence, and locked enable validation. It updated existing poll/UI tests for the new enable rule. Migration tests passed on an empty disposable schema and a populated Milestone 01 schema, including repeat migration and retained cursor, run identity, answers, and timestamps. `npm test` passed 39/39 against `automator_m01_test` with `PGPASSWORD` only in the test process; `npx tsc --noEmit`, `npm run lint`, `npm run build`, focused Prettier, and `git diff --check` passed. A separate reviewer found that Date+time and duration question modes were accepted and complete-looking saves could bypass metadata; both were fixed with failing-first tests. Its scoped re-review found no remaining blocking defect and independently passed the five config tests. No live Form check was run. The current UI cannot enable a workflow until Tasks 4–5 wire live metadata. No Git action was taken for Task 1.
- 2026-10-09: The owner revised the Milestone 02 workflow again: only the main agent may stage, commit, or push after its own approval and separate critic approval. Per-task owner review is no longer required; owner review remains at the milestone gate. The earlier progress note remains a record of the previous instruction, not the current execution rule.
- 2026-10-09: The owner confirmed Task 1 was committed and pushed as `e66c955`. The main agent checked the commit contains the Task 1 files and the prior 39/39 test, typecheck, lint, build, migration, and critic re-review evidence, then marked Task 1 complete without rewriting it. The owner now prohibits any further push or merge during Milestone 02; reviewed remaining tasks receive local commits only. The pre-existing unrelated work in `docs/plans/01-milestone.md`, `next-env.d.ts`, and `docs/plans/post-mvp-roadmap.md` was excluded from milestone task commits.
- 2026-10-09: Task 2 now captures the final locked workflow Form ID and configuration in each new run within the cursor transaction. Tests cover later edits, an edit during fetch, Form ID changes after disable, duplicate responses, rollback, and legacy null snapshots. The read-only critic found `configSnapshot` on the wrong TypeScript type; the main agent corrected it and added an explicit snapshot fixture. Scoped re-review found no remaining blocking issue. The main agent ran `npm test` against `automator_m01_test` with `PGPASSWORD` limited to the test process (48/48 passed), `npx tsc --noEmit`, `npm run lint`, scoped Prettier, and `git diff --check` (all passed). Task 2 was locally committed after the code and plan reviews; no push or merge was performed.

- 2026-10-09: Task 3 added server-side Forms question metadata and the `forms.body.readonly` OAuth scope while retaining response-list access. The read-only critic found that missing local-token errors were masked as Form-access errors; the Forms implementer preserved the safe reconnect instruction and added a failing-first regression test. Scoped re-review found no remaining blocker. After the owner refreshed consent, the live API returned six supported questions: two short text, one multiple choice, one date, one time, and one paragraph; no credentials or answer values were printed. The Form currently has optional Request type and Time questions and lacks an exact `Consultation` choice, so the owner was asked to correct those before Task 6 acceptance. Metadata access itself is verified; complete reference-Form validation remains pending. The Forms implementer passed 6/6 focused tests, typecheck, lint, and scoped Prettier; after integration the main agent passed `npm test` 49/49 with `PGPASSWORD` limited to the test process, `npx tsc --noEmit`, `npm run lint`, `npm run build`, scoped Prettier, and `git diff --check`. Task 3 was locally committed after review; no push or merge was performed.
- 2026-10-09: Task 4 added the fixed-order create/edit builder, server-side Forms metadata read before complete saves, draft persistence, and sample-value Filter/Calendar/Gmail preview. The read-only critic found the selected Calendar ID missing from the review section; the UI implementer added it with a failing-first test, and scoped re-review found no remaining blocker (focused tests 12/12). The implementer ran `npm test` 57/57 against the disposable test database with `PGPASSWORD` only in the test process, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and scoped Prettier (all passed); the main agent ran `git diff --check` (passed). Client loading, inaccessible Form, and empty Form transitions still need live browser evidence in Task 6. Task 4 was locally committed after review; no push or merge was performed.
- 2026-10-09: Task 5 added home/edit status, navigation, consultation-flow copy, and metadata-validated enablement; disabling does not read Form metadata. The read-only critic found that queued-run history wording was too broad and the no-workflow empty state lacked a direct test. The UI implementer narrowed the copy to Milestone 01 runs without snapshots, added a non-destructive isolated-schema empty-state test, and asserted that disabling makes no Forms metadata read. Scoped re-review found no remaining blocker (focused UI tests 17/17). The implementer passed `npm test` 62/62 against the disposable test database with `PGPASSWORD` only in the test process, `npx tsc --noEmit`, `npm run lint`, `npm run build`, and scoped Prettier; the main agent checked the diff and Git identity. Live browser acceptance remains for Task 6. Task 5 was locally committed after review; no push or merge was performed.
- 2026-10-09: Task 6 migrated two newly created disposable PostgreSQL databases, one empty and one populated with a Milestone 01 workflow/run. Repeat migrations recorded exactly `001_init` and `002_workflow_config`; the legacy workflow was disabled while its run, null snapshot, cursor, and timestamps remained intact. Both databases were dropped after the check. The main agent ran `npm test` 62/62 with `PGPASSWORD` only in the test process, `npx tsc --noEmit`, `npm run lint`, and `npm run build` (all passed). A fresh disposable acceptance database was migrated and the production app started on port 3001. After the owner corrected Request type/Time to required and added the exact `Consultation` choice, live metadata returned six supported questions and validated the reference mapping. Browser Harness showed the empty home/runs states, question loading, preview, safe inaccessible-Form error, rejection of the previously invalid complete save, incomplete draft persistence and disabled enable control, then complete save and successful enablement. Restarting the app preserved Complete/Enabled status; `worker:once` passed with zero runs. A separate incomplete configuration was rejected by server-side enablement and remained disabled. The owner's first new response produced one queued run with a non-null matching source-Form/config snapshot; a repeat poll kept the count at one. After an enabled workflow edit, the original snapshot kept its earlier Gmail subject while current config changed. The second response produced a second queued run with the new subject snapshot. Two further polls, including one after re-enabling, kept exactly two distinct runs; both snapshots retained the source Form ID. The browser showed both runs, enabled and disabled states, edit and preview, and Milestone 03 action wording. Disabling left run count and last checked time unchanged; re-enabling advanced the baseline, and the final acceptance workflow was left disabled. No Calendar or Gmail action was invoked. The empty-Form UI state was not exercised with a live empty Google Form; the inaccessible Form and invalid metadata paths were exercised live. The integrated read-only critic found no blocking code defect before the final live checks; final evidence review is pending. No push or merge was performed.
