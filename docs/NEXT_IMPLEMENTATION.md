# SwiftDrop implementation checkpoint

## Completed in the current production-hardening pass

- Pickup-photo uploads are authenticated, bound to the assigned driver and delivery, and stored privately.
- Production pickup-photo and driver-KYC files now use S3-compatible private object storage; local private storage remains available only for development.
- Public file serving is not exposed; pickup evidence and KYC documents are returned through authorization-checked API endpoints.
- Production startup now fails fast when database, JWT, Paystack, CORS, or private object-storage configuration is missing or insecure.
- GPS updates remain bearer-authenticated and driver-assignment checked, with server-generated timestamps, coordinate validation, accuracy validation, and a minimum update interval.
- Receiver six-digit PIN verification is rate-limited to reduce brute-force attempts.
- Background location tracking remains enabled from the driver app while an active delivery is in transit.
- Paystack webhook verification uses the exact raw request body and constant-time signature comparison.
- Payment initialization now uses the same `PAYSTACK_SECRET_KEY` configuration used by Paystack webhooks and transfers.
- Notification records now use a database-backed outbox with retry/backoff and Expo push delivery; invalid device tokens are removed.
- CI is a genuine quality gate: workspace builds and API tests must pass; failures are fixed at source/configuration level rather than suppressed.
- The API test job does not depend on an npm lockfile cache until a reproducible lockfile is committed.
- The latest CI source repairs corrected the driver earnings-style reference and customer tracking destination coordinates to use the nested `dropoff.location` model.

## Remaining production milestones

1. Add automated database integration coverage for every delivery-state transition, receiver PIN completion, escrow release, disputes, support, payout webhooks, notification outbox, and object-storage authorization.
2. Add Expo push receipt polling and durable receipt/error records so provider-level delivery failures are reconciled after push tickets are issued.
3. Add production observability: structured request IDs, error tracking, metrics, alerting, and operational dashboards.
4. Finish mobile app-store production configuration, privacy disclosures, terms/acceptable-use flows, notification credentials, and release builds.
5. Commit a reproducible npm lockfile and restore locked installs/caching in CI once dependency resolution is stable.
6. After CI is verified green, enable branch protection with required production CI checks.
