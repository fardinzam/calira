# Automator

Automator is a focused workflow automation project for a solo service provider. The intended flow takes a new Google Form consultation request, applies a simple Filter, creates a Google Calendar event, and sends a plain-text Gmail acknowledgement. The provider can inspect each run and see failures. This is a working portfolio product with limited integrations, not a general Zapier clone.

## Current status

Milestone 01 is in progress. The Next.js scaffold and database schema are present. Workflow setup, Forms polling, and run visibility are not implemented yet. Calendar and Gmail execution come in later milestones.

## Run locally

Run `npm install` and `npm run dev` to view the scaffold. To migrate an empty PostgreSQL database, provide `DATABASE_URL` to the command, for example `DATABASE_URL='postgresql://postgres@localhost:5432/automator_m01_test' npm run db:migrate` (with your local PostgreSQL authentication configured). The migration script does not load `.env.local`. `npm test` checks the worker's missing-secret error. The worker is a placeholder until Milestone 01 Task 4; it cannot poll Forms yet.

## Project docs

- [Product scope](docs/product.md) — purpose, intended user, MVP behavior, non-goals, and acceptance criteria.
- [Technical architecture](docs/architecture.md) — stack, component boundaries, data model, execution, and reliability decisions.
- [Decision log](docs/decisions.md) — dated choices and what they replaced.
- [MVP roadmap](docs/roadmap.md) — milestone sequence and acceptance-criterion coverage.
- [Milestone 01 plan](docs/plans/01-milestone.md) — tasks, ownership, progress, and acceptance tests.
- [Interview evidence log](docs/interview-notes.md) — incidents and decisions to record during the build, not prepared answers.
