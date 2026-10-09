# Automator — Technical Architecture

## Status and authority

This document records the technical decisions for the MVP defined in [product.md](./product.md). Product purpose, user-visible behavior, and acceptance criteria belong in `product.md`; implementation details belong here. An item marked **Open** is not a decision. The MVP is a single-owner portfolio demonstration, not a general automation platform.

## Chosen stack

| Part                 | Choice                                          | Reason                                                                                                                        |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Language             | TypeScript                                      | One language across UI, API, and worker; matches the existing project preference.                                             |
| Web app              | Next.js with React                              | Supports the small landing page, builder, run views, and server endpoints in one app.                                         |
| Styling              | Tailwind CSS                                    | Standard utilities are sufficient for the deliberately plain interface.                                                       |
| Background execution | One Node.js worker process in the same codebase | Forms polling and workflow runs must continue without a browser tab or web request and recover after an app restart.          |
| Durable storage      | PostgreSQL                                      | Persists workflows, poll progress, runs, and step outcomes; unique constraints and transactions support duplicate prevention. |
| Database access      | `pg`                                            | A direct PostgreSQL client is sufficient for the small number of MVP queries; no ORM is needed yet.                           |
| Google access        | Official Google APIs through `googleapis`       | Uses a maintained Node client for OAuth token refresh and the three API integrations instead of custom HTTP plumbing.         |

The web app and worker are two processes sharing one database and the small set of workflow and Google action code they need. There is no separate message broker, distributed scheduler, general node graph engine, or service layer in the MVP. The worker can claim pending runs from PostgreSQL. Its exact hosting and process supervision are **Open** until deployment is planned.

## Component boundaries

| Component                   | Responsibility                                                                                                    | Does not do                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Web UI and server endpoints | Validate and save workflow configuration; display workflows and runs; accept explicit Gmail retry requests.       | Poll Forms or execute long-running actions inside a request. |
| Forms poller (worker)       | Check enabled Forms, persist unseen responses as runs, and advance poll progress safely.                          | Perform Calendar or Gmail actions while fetching pages.      |
| Run executor (worker)       | Claim one queued run, evaluate Filter, validate mapped data, execute Calendar then Gmail, and record each result. | Interpret arbitrary graphs or expressions.                   |
| Google API code             | Make the specific Forms list, Calendar insert/get, and Gmail send calls; classify API errors.                     | Decide workflow state or silently retry side effects.        |
| PostgreSQL                  | Hold configuration, response identity, execution progress, and result IDs.                                        | Store Gmail inbox contents or become a general event store.  |

Keep these as straightforward modules in one codebase. A boundary is useful only where it separates a concrete responsibility or makes an external API testable.

## Data model

These are logical records, not a commitment to a particular ORM or exact SQL column names.

| Record            | Required data and constraints                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`        | ID, name, enabled flag, Form ID, Calendar ID, provider time zone, selected Form question IDs, Filter value, Calendar field mapping, Gmail recipient/subject/body mapping, creation/update times, and latest enable time. The configuration is limited to the reference flow and fixed step order. |
| `form_poll_state` | Workflow ID, last fully persisted response timestamp, last successful check time, and optional last error. One row per workflow.                                                                                                                                                                  |
| `run`             | ID, workflow ID, Form response ID, submission timestamp, response data needed by the workflow, configuration snapshot, run state, timestamps, and error summary. Unique `(workflow_id, form_response_id)` prevents a second run for the same submission.                                          |
| `step_run`        | Run ID, fixed step name (`filter`, `calendar`, `gmail`), state, attempt count, start/end times, safe error details, and external Calendar event or Gmail message ID after success. Unique `(run_id, step_name)`.                                                                                  |

The run keeps the source Form ID and a configuration snapshot so changing a workflow cannot change an in-progress run or its retry. Milestone 01 runs without a snapshot remain detection history. On the Milestone 02 migration, disable enabled legacy workflows that lack complete configuration; they can be re-enabled after setup is complete. Store only the Form answers needed for execution and run inspection. Google access and refresh tokens are secrets, not workflow configuration; for the single-owner MVP they are provided to the server/worker through a local or deployment secret store, never committed to Git or sent to the browser. The token-at-rest mechanism for later multi-user accounts is **Open**.

## Run states and step states

| Run state          | Meaning                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`           | Response is recorded; execution has not started.                                                                                                                                                              |
| `running`          | Worker has claimed the run and is evaluating or calling an action.                                                                                                                                            |
| `filtered_out`     | Filter did not match; no Calendar or Gmail call is made. Terminal.                                                                                                                                            |
| `succeeded`        | Calendar and Gmail APIs accepted the actions. Terminal. This does not prove email delivery.                                                                                                                   |
| `failed`           | Run stopped before a confirmed successful external action, including invalid data or authorization failure. If a Calendar insert cannot be reconciled, show that its outcome is uncertain and require review. |
| `partially_failed` | Calendar succeeded, but Gmail failed or its outcome is uncertain. Calendar is not rolled back. Gmail may be retried under the rules below.                                                                    |

Step states are `pending`, `running`, `succeeded`, `skipped`, `failed`, and `uncertain`. `uncertain` means an external action may have happened but its result could not be confirmed. The UI must show this and warn before any manual repeat. A run with a successful Calendar step and an uncertain Gmail step is `partially_failed`.

## Workflow execution lifecycle

1. The provider saves a valid workflow and enables it. Enabling or re-enabling establishes a new baseline at the current time; submissions from while it was disabled are not backfilled. The exact polling interval is **Open**.
2. The poller fetches responses submitted since its durable baseline. It persists each unseen response as a `queued` run. Repeated responses are ignored by the unique `(workflow_id, form_response_id)` constraint. It advances the poll timestamp only after all fetched pages and their run records are persisted.
3. The executor claims a queued run in a database transaction. It reads the stored response and configuration snapshot, evaluates the equality Filter, and records `filtered_out` if it does not match.
4. For a matching response, it validates all values required by the later actions before creating any Google side effect: recipient, requested time, time zone, event duration/end time, and mapped text. A bad input produces `failed`.
5. It creates the Calendar event, records the returned event ID, then sends the Gmail acknowledgement and records the returned message ID. Each step result is committed before moving to the next step.
6. The run becomes `succeeded` when both actions succeed. Calendar success followed by Gmail failure becomes `partially_failed`; the Calendar event remains.
7. A manual Gmail retry resumes only the saved Gmail step using the run's original input/configuration. It never repeats Filter or Calendar.

The worker must reclaim work left `running` by a process crash. Before repeating any external action, it reconciles the saved step state with the rules below. Database transactions cannot make a Google API call and a database write atomic; the design does not claim exactly-once external delivery.

## Forms polling and duplicate handling

Use `forms.responses.list` with a timestamp filter and follow every `nextPageToken`. Store a durable high-water timestamp. Query inclusively at the boundary (`timestamp >= ...`) and rely on the unique response ID to handle equal timestamps, overlapping checks, and a crash before the cursor advances. The Forms response includes `responseId`, `createTime`, `lastSubmittedTime`, and answers keyed by question ID. Treat only a response's first submission as a new trigger; later edits do not create another run. If an unseen old response is edited after a re-enable, compare its `createTime` with the current enable baseline before creating a run. [Forms list API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list); [Form response fields](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses).

Only one poll of a given workflow may advance its cursor at a time. A database claim/lock is enough for the MVP. A failed page fetch must leave the cursor unchanged; the next poll can safely repeat because run insertion is idempotent. Disabling stops new polling and run creation. The executor will not claim queued runs while their workflow is disabled; a run already in progress finishes. Re-enabling may resume eligible queued runs, but submissions made while disabled are not backfilled.

## Calendar action

Create one event on the configured Calendar with a title identifying the request, the mapped notes, and explicit start/end date-times in the provider's time zone. The reference Form has short-answer name and email questions, a multiple-choice request type, a Date question with year, a Time question, and an optional paragraph-answer notes question. The selected date and time answers are `YYYY-MM-DD` and `HH:mm`, interpreted in the provider's `America/Los_Angeles` time zone; the event lasts 60 minutes. Reject nonexistent or ambiguous local times before any Google action. Do not add the requester as a Calendar attendee: the Gmail action sends the acknowledgement, and duplicate Calendar invitation mail would be confusing. Do not check availability or claim the booking is confirmed.

Use a stable Calendar event ID derived from the run ID and valid for Google's event-ID format. Save it before the insert call. If the worker loses the insert response, look up that ID before attempting another insert. A found event completes the Calendar step; a definite failed insert can be retried. If the result cannot be reconciled, stop for review instead of creating a second event. Google permits client-supplied event IDs but notes that collision detection is not guaranteed, so this is duplicate protection rather than an absolute exactly-once guarantee. [Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

## Gmail action

Send only a plain-text message from the authorized account's primary address. The workflow provides recipient, subject, and body. Construct the minimal RFC-compliant message required by Gmail, then base64url-encode it for `users.messages.send`. Validate the recipient and reject CR/LF in header values. A small maintained message builder or direct construction with Node APIs are both viable; the exact choice is **Open**. No MIME parser is needed. [Gmail sending guide](https://developers.google.com/workspace/gmail/api/guides/sending).

Record a successful API response and its message ID as `succeeded`. This means Gmail accepted the send request, not that the recipient received the message. Gmail does not provide a workflow idempotency key here. If a request times out, returns an ambiguous server error, or the worker crashes after making the call but before saving its response, mark the step `uncertain` and do not resend automatically. Show the duplicate-email risk before manual retry.

## Google authorization

The MVP uses one developer-controlled Google account. Obtain user consent for only the access needed by the three calls: Forms response read access, Calendar event creation/read-back on the chosen calendar, and `gmail.send`. The exact Forms and Calendar scope combination is **Open** pending a test against the chosen calendar and Form; `gmail.send` is the intended Gmail scope. Google categorizes it as sensitive. [Forms list scopes](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list); [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth); [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

The server and worker use the same authorized account and refresh access tokens as needed. If consent is revoked or refresh fails, stop the affected run and show that reconnection is required. App login is separate and deferred. Better Auth versus Supabase, account-specific Google connections, token encryption/storage, and public OAuth verification belong to the post-MVP design and remain **Open**.

## Retry policy

- Retry bounded, clearly rejected transient requests such as rate-limit responses using backoff. Persist the next attempt time rather than sleeping inside a web request. Exact attempt count and backoff schedule are **Open**.
- Do not automatically retry validation errors, missing permissions, or revoked authorization. Show the error and required correction.
- For Calendar, reconcile by stable event ID after ambiguous outcomes before any retry.
- For Gmail, do not automatically retry an ambiguous send. A manual retry requires a warning. A definite rejected send may be retried without repeating Calendar.
- Persist step attempts and safe error details. Never include OAuth tokens or full API responses in user-visible logs.

## Open decisions

- **Open:** Exact polling interval, hosting, and process supervision.
- **Decided for the reference flow:** Six Form questions: short-answer name/email, multiple-choice request type, Date with year, Time, and optional paragraph notes. Their separate date/time answers are `YYYY-MM-DD` and `HH:mm`, in `America/Los_Angeles`, with a 60-minute event. The exact question IDs come from the new owner-controlled Form during setup.
- **Decided:** Disabling pauses queued work; already running work finishes. Milestone 01 runs without a configuration snapshot remain detection history and are not eligible for action execution.
- **Open:** Exact retry attempt count/backoff and the minimal Gmail message-construction approach.
- **Open:** Post-MVP app auth provider, multi-user token storage, and public OAuth verification/deployment approach.
