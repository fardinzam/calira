# Automator — MVP Roadmap

**Status:** Milestones 01–03 complete; Milestone 04 implementation and final acceptance passed, with owner review pending. This roadmap connects [Milestone 01](plans/01-milestone.md) to all nine acceptance criteria in [product.md](product.md). `product.md` is authoritative for MVP behavior; [architecture.md](architecture.md) is authoritative for technical design. Detailed execution plans are written and reviewed one milestone at a time. The MVP can be verified locally with one developer-controlled Google account; public deployment and multi-user app auth are outside this roadmap.

## Sequence

| Milestone                                      | Reviewable result                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **01 — Forms ingestion and run visibility**    | A new Form submission appears once as a durable `queued` run in the simple app.                                                                                                |
| **02 — Complete workflow configuration**       | The owner can configure and save the reference Forms → Filter → Calendar → Gmail workflow through a simple builder, with invalid configuration rejected before enablement.     |
| **03 — Working automation**                    | A qualifying response passes Filter, creates one Calendar event, sends one plain-text Gmail acknowledgement, and shows step results; a nonqualifying response is filtered out. |
| **04 — Failure recovery and MVP verification** | Failures, partial runs, safe retries, restart recovery, and the complete user journey meet every product acceptance criterion.                                                 |

### Milestone 01 — Forms ingestion and run visibility

**End result:** The owner can configure a Form ID, enable polling, submit a response, and see one persisted `queued` run with its response ID and submission time. The [existing detailed plan](plans/01-milestone.md) controls this milestone's tasks and scope.

**In scope:** Local app and worker setup, one developer account's Forms read authorization, workflow enable/disable, paginated polling, durable cursor, response-ID deduplication, and a basic run list.

**Deferred:** Filter execution, Calendar, Gmail, full field mapping, step details, app login, public deployment, and visual polish.

**Dependencies:** None. This is the starting milestone.

**Acceptance checks:** A new response appears once; repeated polls, equal timestamps, pagination, and a worker restart do not lose or duplicate runs; a failed page leaves the cursor recoverable; disabled-period responses are not backfilled; credentials stay out of browser output. These checks are specified in the Milestone 01 plan.

**Decision before its execution plan:** The plan already exists. Its live Google check needs a developer-owned Form and credentials supplied at execution time. No additional product behavior should be inferred from those test values.

### Milestone 02 — Complete workflow configuration

**End result:** The owner can use a plain step-by-step builder to save the reference workflow: select the Form and Calendar, choose the required Form answers, set the equality Filter, map the Calendar event, write the Gmail recipient/subject/plain-text body, and enable or disable the workflow. A bare landing page explains this narrow use case. The builder makes clear that action execution is not yet available until Milestone 03.

**In scope:** Persisting the complete fixed-order configuration; showing the provider time zone and required fields; validation and a readable preview of mapped values; editing and enable/disable behavior; a basic empty/error state. Configuration saved for later runs must not silently change the inputs of an already recorded run, consistent with `architecture.md`.

**Deferred:** Calling Calendar or Gmail, step execution, retries, a canvas, arbitrary expressions, and general-purpose templates.

**Depends on:** Milestone 01's saved workflows, Form response data, and basic pages.

**Acceptance checks:** A valid reference workflow survives a restart and can be enabled; an incomplete or invalid configuration cannot be enabled; the Filter comparison and every required action input can be reviewed before enablement; changing a saved workflow does not silently alter an earlier run's captured configuration; enable/disable status is visible. This milestone prepares product criterion **1**; the live-action portion is confirmed later.

**Decisions for its detailed plan:** The reference Form question types and mapping, requested-time format, provider time zone, 60-minute event, legacy run treatment, and disable behavior are recorded in [the Milestone 02 plan](plans/02-milestone.md), [architecture](architecture.md), and [decision log](decisions.md).

### Milestone 03 — Working automation

**End result:** A qualifying new Form submission creates one Calendar event and sends one plain-text Gmail acknowledgement from the authorized primary address. A nonqualifying submission stops at Filter. The run detail view shows the state and result of each step. This is the first complete happy path; an action failure stops visibly, with the fuller recovery behavior in Milestone 04.

**In scope:** Fixed-order Filter → Calendar → Gmail execution by the worker; pre-action validation of required response values; one developer account authorized for Calendar and Gmail as well as Forms; stored step outcomes and external IDs; run states for success, filtered out, and failure; basic run detail and error display. Calendar events are requests, not confirmed appointments, and the Gmail message acknowledges receipt only.

**Deferred:** Automatic retry policy, ambiguous-send handling, Gmail-only manual retry, public account connection, availability checks, and workflow branching.

**Depends on:** Milestone 01's durable ingestion and Milestone 02's validated configuration and snapshots.

**Acceptance checks:** A qualifying response produces one mapped event and one plain-text email in order, with a `succeeded` run and visible step results; a nonqualifying response records `filtered_out` and makes neither Google action; missing/invalid required data fails before any action; a definite Google API error is visible rather than reported as success. These checks cover the happy-path parts of product criteria **2, 4, 5, and 6**.

**Decisions before its detailed plan:** Confirm the minimum Forms and Calendar OAuth scopes against the reference resources, how the chosen Calendar and primary Gmail sender are identified, and the minimal plain-text message-construction approach. Define the action boundary and state transitions so Milestone 04 can resume a step without replaying a successful one. The main agent owns those cross-integration decisions.

### Milestone 04 — Failure recovery and MVP verification

**End result:** The owner can inspect, understand, and recover from failed runs. The complete Forms → Filter → Calendar → Gmail journey passes all nine product acceptance criteria with real test submissions and deliberate failure cases. A plain home page and run history show success, filtered-out, failed, and partially failed runs without implying email delivery is guaranteed.

**In scope:** Bounded retries for definitely rejected transient failures; Calendar duplicate protection and reconciliation after an uncertain insert; persistence and recovery of interrupted runs; partial failure when Calendar succeeds and Gmail fails; a Gmail-only manual retry; an explicit duplicate warning when a send outcome is uncertain; useful safe errors and final local end-to-end checks. Keep the successful Calendar event when Gmail fails.

**Deferred:** Post-MVP workflow tools, multi-user app auth, public deployment, monitoring infrastructure, production-scale guarantees, and redesign of the builder.

**Depends on:** A demonstrated Milestone 03 happy path and stored step outcomes/IDs.

**Acceptance checks:** Replaying a Form response or restarting the worker does not create a second run or repeat confirmed successful actions; Calendar success followed by Gmail failure is `partially_failed` and Gmail-only retry leaves the event untouched; an uncertain Gmail outcome is labeled before any manual resend; permissions and validation failures are visible; runs continue after an app/worker restart. Finally, demonstrate the reference flow through the builder, polling, Filter, both actions, and run detail with the developer account. These checks complete product criteria **1–9**, especially **3, 6, 7, 8, and 9**.

**Decisions before its detailed plan:** Set the retry attempt limit and backoff, the exact treatment of Calendar outcomes that cannot be reconciled, and the manual retry behavior for an uncertain Gmail send. Preserve `architecture.md`'s rule that an ambiguous Gmail send is never retried automatically.

## Acceptance-criterion coverage

| `product.md` criterion                                     | Completed by                                 |
| ---------------------------------------------------------- | -------------------------------------------- |
| 1. Configure, save, enable, disable through the builder    | 02; verified end to end in 04                |
| 2. Qualifying response creates event and acknowledgement   | 03; verified end to end in 04                |
| 3. Recheck creates no duplicate run/event/email            | 01 for run identity; 04 for external actions |
| 4. Filtered response creates no event or email             | 03                                           |
| 5. Invalid required values fail visibly before action      | 02 for configuration; 03 for response data   |
| 6. Run detail shows every step result or error             | 03; failure cases completed in 04            |
| 7. Calendar retained after Gmail failure; Gmail-only retry | 04                                           |
| 8. Uncertain Gmail outcome shown before manual retry       | 04                                           |
| 9. Processing survives app/worker restart                  | 01 for ingestion; 04 for full execution      |

## Decisions before execution

- **Previously reported doc conflicts are resolved in the current files:** Filter appears in the MVP but no longer in the post-MVP list of `product.md`. `architecture.md` now accepts `pg` and `googleapis`, matching Milestone 01. Do not reintroduce either discrepancy when writing later plans.
- **Milestone 01 link repair is still needed when that file is next edited:** It moved to `docs/plans/`, but its `Sources` links still point to `./product.md`, `./architecture.md`, and `./decisions.md` rather than their parent directory. This roadmap does not modify that file.
- **Before Milestone 02:** Resolved in the Milestone 02 plan, architecture, and decision log: reference Form schema, time zone and event duration, treatment of existing `queued` runs, and disable behavior for in-progress runs.
- **Before Milestone 03:** Resolve the exact Forms/Calendar scopes and minimal Gmail message construction; verify Google access with the developer-owned resources.
- **Before Milestone 04:** Resolve bounded retry values and review paths for ambiguous Calendar and Gmail outcomes.

Builder UI, individual Google action adapters, and focused tests can be delegated after their interfaces and acceptance checks are agreed. The main agent owns product/architecture consistency, shared data and run-state contracts, OAuth scope decisions, failure semantics across actions, and the final end-to-end verification. No later milestone has a subagent assignment yet.
