# SwiftDrop implementation checkpoint

## Completed in the current production-hardening pass

- Pickup-photo uploads are authenticated, bound to the assigned driver and delivery, and stored privately.
- Production pickup-photo and driver-KYC files now use a private Supabase Storage bucket; local private storage remains available only for development.
- Public file serving is not exposed; pickup evidence and KYC documents are returned through authorization-checked API endpoints.
- Production startup now fails fast when database, JWT, Paystack, CORS, or private object-storage configuration is missing or insecure.
- GPS updates remain bearer-authenticated and driver-assignment checked, with server-generated timestamps, coordinate validation, accuracy validation, and a minimum update interval.
- Receiver six-digit PIN verification is rate-limited to reduce brute-force attempts.
- Background location tracking remains enabled from the driver app while an active delivery is in transit.
- Paystack webhook verification uses the exact raw request body and constant-time signature comparison.
- Payment initialization now uses the same `PAYSTACK_SECRET_KEY` configuration used by Paystack webhooks and transfers.
- Notification records now use a database-backed outbox with retry/backoff and Expo push delivery; invalid device tokens are removed.
- Expo push ticket IDs and provider receipts are now persisted and reconciled by a background worker, including invalid-token cleanup from receipt errors.
- Private storage keys reject traversal and absolute paths.
- Delivery transitions now use a central state machine and database transitions verify driver ownership atomically.
- API requests now receive a unique `x-request-id`, with structured request/error logs that avoid request bodies and credentials.
- Customer and driver Expo configuration now uses environment-driven dynamic configs with production bundle/package identifiers and EAS build profiles.
- CI run #277 passed all workspace builds and API tests after the production-hardening changes.
- CI is a genuine quality gate: workspace builds and API tests must pass; failures are fixed at source/configuration level rather than suppressed.
- The API test job does not depend on an npm lockfile cache until a reproducible lockfile is committed.
- The latest CI source repairs corrected the driver earnings-style reference and customer tracking destination coordinates to use the nested `dropoff.location` model.

## Remaining production milestones

1. Add automated database integration coverage for every delivery-state transition, receiver PIN completion, escrow release, disputes, support, payout webhooks, notification outbox, and object-storage authorization.
2. Add external error tracking, metrics, alerting, and operational dashboards on top of the request-ID logging foundation.
3. Finish mobile app-store production configuration, privacy disclosures, terms/acceptable-use flows, notification credentials, and release builds; legal text should receive Nigerian counsel/privacy review before launch.
5. Commit a reproducible npm lockfile and restore locked installs/caching in CI once dependency resolution is stable.
6. After CI is verified green, enable branch protection with required production CI checks.


## Latest production hardening
- CI workflow is green across API tests and all workspace builds.
- Production API now requires private object storage configuration and validates private object keys on read/write.
- Notification delivery uses a durable outbox, retry backoff, Expo push tickets and receipt reconciliation.
- API request IDs and structured request/error logs are enabled for operational tracing.
- Customer and driver apps have environment-driven Expo production configuration and EAS build profiles.
- Final legal documents remain subject to Nigerian legal/privacy review before public launch.

- Paystack refund accounting now tracks cumulative refunded amounts and uses a unique refund-event record so repeated webhook deliveries cannot double-count a refund.
- Paystack webhook duplicates are safely reprocessed instead of being discarded after an early idempotency claim; signed events remain the source of truth and downstream financial mutations are idempotent.
- Payout transfer references are reserved before the provider request, allowing webhook reconciliation even when the initiating HTTP request times out.
- Admin dispute release now atomically releases held escrow and creates/maintains courier payout eligibility.
- Direct arbitrary KYC document URL submission has been disabled; drivers must use the private upload flow.


## Added after the checkpoint
- Recurring business dispatch rules, cancellation, and a due-rule worker are implemented.
- Private SwiftDrop parcel/KYC/receipt storage now uses a Supabase Storage private bucket in production.