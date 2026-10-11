# Automator

Automator is a focused workflow automation project for a solo service provider. The intended flow takes a new Google Form consultation request, applies a simple Filter, creates a Google Calendar event, and sends a plain-text Gmail acknowledgement. The provider can inspect each run and see failures. This is a working portfolio product with limited integrations, not a general Zapier clone.

## Current status

Milestones 01–03 are complete. Milestone 04 recovery and safe retry implementation passed final acceptance; owner review is pending.

## Run locally

Run `npm install`, configure the local values shown in `.env.example`, and run `npm run db:migrate` with `DATABASE_URL` set. Start the app with `npm run dev`; use `npm run worker:once` to poll Forms and process eligible queued runs once, or `npm run worker` for the 60-second loop. The migration script does not load `.env.local` itself. Tests use a separate `TEST_DATABASE_URL` and local PostgreSQL authentication.

## Project docs

- [Product scope](docs/product.md) — purpose, intended user, MVP behavior, non-goals, and acceptance criteria.
- [Technical architecture](docs/architecture.md) — stack, component boundaries, data model, execution, and reliability decisions.
- [Decision log](docs/decisions.md) — dated choices and what they replaced.
- [MVP roadmap](docs/roadmap.md) — milestone sequence and acceptance-criterion coverage.
- [Milestone 01 plan](docs/plans/01-milestone.md) — tasks, ownership, progress, and acceptance tests.
- [Milestone 02 plan](docs/plans/02-milestone.md) — workflow configuration and Forms mapping.
- [Milestone 03 plan](docs/plans/03-milestone.md) — working automation and live acceptance.
- [Milestone 04 plan](docs/plans/04-milestone.md) — recovery, safe retry, and MVP acceptance.
- [Interview evidence log](docs/interview-notes.md) — incidents and decisions to record during the build, not prepared answers.
