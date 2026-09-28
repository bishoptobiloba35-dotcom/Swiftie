# Production deployment checklist

## API
- Set all variables in `services/api/.env.example` from a secret manager; never commit real credentials.
- Production startup rejects missing database, JWT, Paystack, HTTPS CORS, and private object-storage configuration.
- Run database migrations during controlled deployment.
- Expose `/health` for liveness and `/ready` for readiness.
- Keep private pickup/KYC objects out of public web roots.

## Mobile
Customer and driver builds use `EXPO_PUBLIC_API_URL` and environment-driven Expo configuration. Set unique production bundle/package identifiers before store submission.

## Payments
- Use live Paystack credentials only in the production secret store.
- Configure the Paystack webhook endpoint and verify its signature.
- Confirm receiver PIN before escrow release.
- Reconcile refunds and payouts from provider events.

## Notifications
The API persists notification outbox entries, retries failed sends, records Expo push tickets and periodically reconciles push receipts. Device tokens reported as unregistered are removed.

## Storage
Production requires private S3-compatible object storage. Local disk is development-only. Object keys are validated against traversal and absolute-path attacks.

## Legal
Before public launch, replace the legal placeholders in `docs/legal/` with the operator's registered identity, official contact details, approved retention policy, prohibited-items policy, cancellation/refund terms, and governing-law/consumer disclosures after Nigerian legal/privacy review.
