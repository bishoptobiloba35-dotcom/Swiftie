# SwiftDrop deployment runbook

## Hosting decision

No founder-selected hosting provider was recorded when this work order began. For this deployment baseline, use **Railway for the API**, **Supabase for PostgreSQL and private object storage**, and **Vercel for the admin web app**. These are documented defaults pending founder confirmation; do not point production traffic at a provider until the founder confirms the accounts, regions, service names, data-processing terms, and billing ownership.

The API deployment workflows are intentionally gated. Staging runs only after the `SwiftDrop CI` workflow succeeds for the exact commit on `main`. Production is a manual `workflow_dispatch` and requires a successful staging deployment for the same commit within the previous 24 hours.

## Runtime environment variables

Configure secret values in Railway/Supabase and GitHub Actions Environments/Secrets. **This document intentionally contains names only; never commit values here.**

Required production API configuration:
- `NODE_ENV`
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_PUBLIC_KEY`
- `SMS_PROVIDER_API_KEY`
- `JWT_SECRET`
- `PIN_HMAC_SECRET`
- `ESCROW_MODE (mock|live)`
- `CORS_ORIGINS`

Additional variables used by existing API features may include `API_PORT`, `PAYMENT_WEBHOOK_SECRET`, `TERMII_API_KEY`, `TERMII_BASE_URL`, `TERMII_SENDER_ID`, and `DRIVER_PAYOUT_PERCENT`. Confirm each provider adapter's exact variable names before launch. The generic `SMS_PROVIDER_API_KEY` must not be assumed to configure Termii until the adapter is explicitly wired to it.

GitHub Actions configuration required by the deployment workflows (configure these in the matching GitHub Environment):

**Secrets**
- `RAILWAY_TOKEN`
- `STAGING_DATABASE_URL`
- `PRODUCTION_DATABASE_URL`
- `SLACK_WEBHOOK_URL` (optional; deployment continues without Slack, but the workflow emits a warning)

**Environment variables** (non-sensitive identifiers and public base URLs)
- `RAILWAY_PROJECT_ID`
- `RAILWAY_STAGING_SERVICE_ID`
- `RAILWAY_PRODUCTION_SERVICE_ID`
- `STAGING_API_URL`
- `PRODUCTION_API_URL`

The staging workflow performs a preflight check and reports all missing required staging values before it attempts migrations. Keep staging and production database URLs, API URLs, and Railway service IDs separate. Use GitHub Environments with required reviewers for production secrets and manual approvals. Never put database URLs or tokens in Actions variables.

## Migration policy

- Deployment migrations run through the API's registered migration runner and the `schema_migrations` version table.
- Verify the version table exists and record the applied migration IDs after every deployment.
- Never delete or rewrite an applied migration. Do not edit an old migration to repair production data.
- Prefer additive, backward-compatible expand/contract changes: add nullable columns/tables first, deploy compatible code, backfill in a controlled job, then remove obsolete fields only in a later release after old code is no longer running.
- For a bad migration, stop rollout and write a **new compensating migration** that safely restores a valid state. Database rollback is not assumed to be safe or automatic.
- The API currently runs registered migrations during startup. The workflow also runs the migration CLI against the target database before deploying the matching API commit.

## Staging release

1. A push to `main` must pass every job in `SwiftDrop CI`.
2. The staging workflow checks out that exact CI commit, installs locked dependencies, applies registered migrations to the staging database, and verifies `schema_migrations`.
3. It deploys the API to the Railway staging service.
4. It requests `/health` and `/ready` with a 30-second curl timeout and checks that both report healthy database connectivity. It publishes status plus commit SHA to Slack when `SLACK_WEBHOOK_URL` is configured; otherwise the optional notification is skipped with a warning.
5. Confirm the reported health payload and inspect the migration version table in Supabase before promoting.

## Production release

1. Confirm the founder has approved hosting/provider accounts, billing, secrets, data region, and the production window.
2. Dispatch `Deploy SwiftDrop API to production` manually from the commit intended for release.
3. The workflow refuses to proceed unless a successful staging deploy for the **same commit** completed within 24 hours.
4. It applies migrations to the production database, deploys the API, verifies `/health`, and sends the status and SHA to Slack.
5. Confirm production `/ready` and provider dashboards manually; `/health` is a liveness check and does not prove escrow, payout, SMS, or other third-party flows work end-to-end.

## Rollback and incident response

**Rollback provider:** Railway's deployment history/rollback controls for the API service. Supabase remains the database provider. Vercel deployment history is the rollback provider for the admin frontend.

**5-minute rollback checklist**
1. **0:00–1:00 — Stop promotion:** disable further deploys, record the incident start time, current SHA, failed SHA, health output, and migration IDs; notify the founder and incident channel.
2. **1:00–2:00 — Roll back application:** in Railway, select the last known-good API deployment and use its rollback/redeploy action. For the admin frontend, use Vercel's prior deployment rollback if relevant.
3. **2:00–3:00 — Verify liveness/readiness:** request `/health` and `/ready`; check logs and database connectivity. Do not declare recovery based on a successful `/health` alone.
4. **3:00–4:00 — Check data compatibility:** inspect `schema_migrations` and application errors. Do not drop schema or delete migration history. If the new schema is incompatible, pause writes where necessary and prepare a reviewed compensating migration.
5. **4:00–5:00 — Communicate:** notify the founder and stakeholders with incident, reverted SHA, health result, migration state, and next action. Keep the incident open until payment/escrow and critical user flows are checked.

A code rollback does not reverse database changes. Never run an unreviewed destructive SQL rollback in an incident.

## Verification record

The GitHub workflow can validate code paths and deployment commands, but a successful real staging deployment, production deployment, health check, migration-table inspection, and rollback require the founder's configured Railway/Supabase/Slack secrets and actual hosted environments. Record URLs, health responses, migration IDs, and rollback outcome here after those operations are performed; do not mark them complete based only on CI.
