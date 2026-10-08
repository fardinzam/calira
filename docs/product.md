# Automator — Product Scope

## Purpose

Automator is a working portfolio product that turns a Google Form response into a small, reliable workflow. It demonstrates an end-to-end service: a user configures a workflow, the service detects a new response, performs actions in order, and shows what happened. It has deliberately limited integrations and workflow tools. It is not a general Zapier clone.

The first version prioritizes correct automation and clear run results over visual polish or a flexible canvas. It should be useful for its narrow task, while remaining small enough for one developer to build, operate, and explain.

## Intended user and concrete workflow

The intended user is a solo service provider who collects consultation requests with Google Forms and manages their schedule in Google Calendar. They want each qualifying request placed on their calendar and acknowledged by email without copying information between apps.

The reference workflow is:

1. A person submits a consultation-request Form with their name, email address, request type, requested date and time, and notes.
2. Automator detects the new response. A Filter continues only when the request type is `Consultation`.
3. Automator creates an event on the provider's chosen Google Calendar using the requester's name, requested time, and notes.
4. Automator sends a plain-text acknowledgement to the submitted email address from the provider's authorized primary Gmail address. The email says the request was received; it does not promise that the appointment is confirmed.
5. The provider can see the outcome of each step in the run history.

This is one example workflow, not a promise to support arbitrary Form structures or every Calendar and Gmail feature. The required Form fields and the provider's time zone must be clear during setup. A response with missing or invalid required values fails visibly rather than creating a misleading event or email.

## MVP features

### Interface

- A bare landing page that explains the example use case.
- A simple home page listing saved workflows and recent runs.
- A step-by-step builder for selecting a Form, configuring the supported Filter, mapping the required Form fields into a Calendar event and Gmail message, and enabling or disabling the workflow. No drag-and-drop canvas is required.
- A run detail view showing each step's status and useful error information.
- A login placeholder may exist for the interface, but app accounts and multi-user access are not part of the MVP.

### Integrations and execution

- Google Forms is the only trigger. The service checks for new responses on a schedule, fetches all available new responses, and records response IDs so the same submission does not start a second run. The first version handles new submissions; edits to an existing response do not start another run.
- Google Calendar creates one event per qualifying response. The MVP does not check availability or prevent scheduling conflicts.
- Gmail sends one plain-text acknowledgement per qualifying response. The supported message fields are recipient, subject, and body. It sends from the authorized account's primary address. There are no attachments, HTML templates, inbox access, or custom sender aliases.
- The Filter supports the reference workflow's simple equality condition on a Form answer. There is no general expression language.
- The builder supports the field mapping needed for the reference workflow. It does not expose every field or operation in the Google APIs.
- Steps execute in order. The service stores the outcome of each step and the identifiers returned by successful Google actions.

### Authorization and failures

- The MVP runs with one developer-controlled Google account. Google authorization for Forms, Calendar, and Gmail is required. App login and account-specific Google connections come later.
- Invalid configuration, missing permissions, invalid response values, and API failures appear in the run history with a clear failed state.
- If Calendar succeeds and Gmail fails, the event remains, the run is marked **partially failed**, and the provider can retry the Gmail step without creating another Calendar event.
- Temporary API failures can be retried in a bounded way. If the outcome of a Gmail send request is unknown, the run shows **send outcome uncertain**; a manual retry warns that it might send a duplicate.
- Gmail usage stays within ordinary account and API limits. The MVP is for individual acknowledgements, not bulk sending.

## Explicit non-goals for the MVP

- A general automation marketplace or support for apps beyond Forms, Calendar, and Gmail.
- Delay, Human in the Loop, Looping, or Paths.
- A collaborative, real-time, or drag-and-drop workflow canvas.
- Arbitrary triggers, actions, expressions, transformations, or complex field mappings.
- App accounts, multi-user workspaces, billing, or public onboarding of Google accounts.
- Calendar availability checks, conflict resolution, rescheduling, or a booking guarantee.
- Gmail reading, HTML email, attachments, aliases, campaigns, or delivery tracking.
- Production-scale throughput or a claim that the product has an established consumer base.

## User-visible behavior

- A provider can save a workflow before enabling it and can tell whether it is enabled.
- A new qualifying Form submission eventually appears as a run. Polling means it is not instant; the interface must not promise real-time execution.
- A nonqualifying response appears as filtered out, with no Calendar event or email.
- A successful run shows the created Calendar event and sent Gmail message as completed steps.
- A failed or partially failed run shows which step stopped, what the provider can do next, and whether retrying could duplicate an email.
- Disabling a workflow prevents later submissions from starting new runs.

## Acceptance criteria

The MVP is complete when all of the following can be demonstrated with a developer-controlled Google account and the reference Form:

1. The provider can configure, save, enable, and disable the reference workflow through the simple builder.
2. A qualifying new Form response starts one run, creates one Calendar event with the mapped information, and sends one plain-text acknowledgement to the submitted address.
3. Rechecking the same Form response does not create another run, event, or email.
4. A response that fails the Filter creates neither an event nor an email, and its run records why it stopped.
5. Missing or invalid required response values produce a visible failure instead of a partial or malformed Google action.
6. The provider can open a run and see the status of every step and the useful result or error from each Google action.
7. A Gmail failure after Calendar success leaves the event intact, marks the run partially failed, and allows retrying only Gmail.
8. An uncertain Gmail send outcome is labeled as such before any manual retry.
9. The reference workflow continues processing new submissions after the app server restarts, using its saved workflow and processed-response records.

## Post-MVP expansion

After the core workflow is dependable, compare established auth solutions such as Better Auth and Supabase, then add real app accounts and account-specific Google connections. After, add workflow tools in this order as they prove useful: 
- Delay: wait to send data to an app by holding actions for a set time.
- Human in the Loop: complete a manual action during a run.
- Looping: run all following steps repeatedly.
- Paths: build different steps for different rules.
- Schedule: actions takes place on predetermined condition(s)

Improve the interface, deploy a portfolio-accessible version, and add operational monitoring and security work appropriate to that release. Consider Forms push notifications only if polling latency becomes a real user problem.
