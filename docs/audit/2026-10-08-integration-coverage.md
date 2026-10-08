# SwiftDrop production integration coverage

This checkpoint converts the remaining high-risk audit items into executable CI coverage without changing the agreed product structure.

## Coverage target

- Delivery state transitions and receiver PIN completion
- Escrow release, disputes and payout eligibility
- Paystack webhook reconciliation and idempotency
- Notification outbox and receipt reconciliation
- Private object-storage authorization
- Server-side feature gates for dormant modules

## Release rule

A green CI run is required before merge. A green PR run alone does not count as post-merge main verification. Readiness is unchanged until the merged main commit is re-audited.

## Next blockers

1. Connect Prometheus alerts to production monitoring/on-call.
2. Complete mobile store/release/legal/privacy configuration.
3. Close remaining payment/lifecycle audit gaps for the broader delivery contract.
