# Automator — Interview Evidence Log

Record incidents and decisions close to when they happen. These are raw facts to draw from later, not polished interview answers. Keep an initial assumption, the evidence that changed it, and the observed outcome. Distinguish a design decision from implemented and tested behavior. Add numbers only when measured.

Useful tags: `hard-problem`, `debugging`, `trade-off`, `reliability`, `scope`, `ownership`, `changed-opinion`, `security`, `feedback`, `ai-use`.

## 2026-10-06 Reframed Kinetk as a focused automation product

Tags: scope, changed-opinion, ownership, ai-use

Context: Kinetk began from a ChatGPT suggestion for a resume project. Most effort went into a real-time multi-user node canvas.
Problem: The project showed frontend effort but lacked a clear consumer purpose. The first replacement scope still listed five Google integrations and five workflow tools.
My role: I reconsidered the product goal and narrowed the proposed scope. This is a planning decision; no new product code has been built yet.
Options considered: Continue the broad canvas-based project; build a general Zapier-like product; build one useful Google workflow with a limited interface.
What I did: Chose the focused workflow. Reduced the MVP from five integrations to Forms, Calendar, and Gmail; deferred Delay, Human in the Loop, Looping, and Paths; kept the builder simple.
Result and evidence: The current product scope and architecture describe one consultation-request workflow. Delivery speed or recruiter impact has not been measured.
What I would do differently: Define the intended user and job-to-be-done before investing heavily in a distinctive interface.
Links: [product scope](./product.md), [decision log](./decisions.md)

## 2026-10-06 Chose Forms polling for the first trigger

Tags: hard-problem, trade-off, reliability, changed-opinion

Context: A Form submission must start a workflow without losing submissions or running the same response twice.
Problem: The initial trigger idea sounded like one notification per submission. Google Forms notifications can be delayed or grouped, contain no response details, require Cloud Pub/Sub, and use watches that expire after seven days.
My role: I evaluated the trigger options and accepted polling as the first implementation approach. No polling code or reliability result exists yet.
Options considered: Forms push notifications through Pub/Sub and renewed watches; periodic `forms.responses.list` calls with a saved cursor and response-ID deduplication.
What I did: Chose polling for the MVP and recorded the intended cursor, pagination, and unique-response behavior in the architecture and first milestone plan.
Result and evidence: The design avoids Pub/Sub setup and watch renewal for the first milestone. It has not yet been tested against a live Form. Google documents timestamp filters and pagination for `responses.list`.
What I would do differently: Revisit push notifications if measured polling delay becomes a real user problem.
Links: [architecture](./architecture.md), [Milestone 01 plan](./01-milestone.md), [Forms responses API](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list), [Forms notification guide](https://developers.google.com/workspace/forms/api/guides/push-notifications)

## 2026-10-06 Simplified the Gmail action after feedback

Tags: trade-off, feedback, reliability, ai-use

Context: Gmail is an action after Calendar creation in the reference workflow.
Problem: An earlier discussion risked spending effort on general MIME handling and email features when the workflow engine is the core of the project. A Gmail failure after Calendar succeeds also makes a full-run retry unsafe.
My role: I pushed for a plain-text send-only action and accepted the partial-run behavior. This is a design decision, not an implemented result.
Options considered: A broader Gmail integration or a small plain-text action; rolling back or repeating the whole workflow versus retaining the Calendar event and retrying only Gmail.
What I did: Limited the message to recipient, subject, and plain-text body from the authorized primary address. Chose to keep a successful Calendar event, mark the run partially failed if Gmail fails, and allow a Gmail-only retry with a duplicate warning when send outcome is uncertain.
Result and evidence: These boundaries are written in the product and architecture documents. No email has been sent by Automator yet, and duplicate-send behavior has not been tested.
What I would do differently: Check every integration proposal against the specific workflow before accepting extra capability suggested during planning.
Links: [product scope](./product.md), [architecture](./architecture.md), [decision log](./decisions.md)

## Evidence to add during implementation

- **Hardest technical problem:** Record the failing case, why it was hard, approaches tried, and the final test or observed run.
- **Debugging:** Capture symptoms, reproduction, logs or database rows that identified the cause, the fix, and a regression test.
- **Reliability:** Record actual duplicate-response, restart, partial-run, retry, and uncertain-send test outcomes. Do not describe planned behavior as delivered behavior.
- **Ownership:** Follow one feature from requirement to design, code, tests, and deployment; include a concrete result.
- **Security and user data:** Record the scopes actually requested, where tokens were stored, a risk found, and the change made.
- **Feedback:** Name the specific reviewer or tester feedback and the resulting change. Do not turn a solo project into a fabricated teamwork story.
- **AI use:** Note a useful AI contribution, an output you rejected or corrected, and how you independently verified the final behavior.

## Entry template

```markdown
## [Date] Short incident or decision title

Tags: debugging, trade-off, reliability

Context:
Problem:
My role:
Options considered:
What I did:
Result and evidence:
What I would do differently:
Links: issue / PR / test / screenshot
```
