# Database RLS Authorization Boundary Audit

## Scope and findings

The repository's API uses a shared PostgreSQL pool and authenticates users in API middleware. The reviewed migrations and bootstrap schema did not previously enable PostgreSQL row-level security (RLS). Existing route-level authorization tests therefore did not prove database-level isolation for non-owner database roles.

This change adds defense-in-depth RLS to core customer, delivery, and payment records. It does not replace API authorization, webhook signature checks, or server-side financial state transitions.

## Policy matrix

| Data | Non-owner role read boundary | Direct client writes |
| --- | --- | --- |
| `users` | Own user row only | Denied |
| `drivers` | Own driver profile only | Denied |
| `deliveries` | Sender or assigned driver | Denied |
| `delivery_events`, `location_events` | Only events for a delivery visible to the actor | Denied |
| `payments`, `escrow_payment_attempts` | Only attempts/payments for a visible delivery | Denied |
| `disputes` | Only disputes for a visible delivery | Denied |
| `notifications` | Own notifications only | Denied |
| `device_tokens` | Own token rows | Own rows only |
| `driver_documents` | Owning driver only | Denied |
| `support_tickets` | Own tickets only | Denied |
| `payouts`, `payout_requests`, `stakeholder_wallets`, `wallet_transactions`, `float_transactions` | Default-deny for non-owner roles | Denied |

Policies read the verified subject from PostgreSQL's `request.jwt.claim.sub` setting. A missing identity produces no matching rows. Financial writes remain server-only; no end-user policy can insert or update payment, escrow, payout, wallet, or float ledger rows.

## Shared-pool compatibility

The current API uses a shared pool and many queries are not wrapped in identity-scoped transactions. This PR therefore does **not** pretend that each API query is executing as an end-user RLS subject. The API must connect as a trusted service role with `BYPASSRLS` or as the owner of all RLS-protected tables. The startup guard fails closed if the configured database role is neither. Do not give this database credential to mobile clients.

For direct client access, use a non-owner, non-`BYPASSRLS` role with only the required table grants. End-user roles must never own the protected tables. PostgreSQL superusers, table owners (unless `FORCE ROW LEVEL SECURITY` is enabled), and roles with `BYPASSRLS` bypass policies; CI explicitly simulates a non-owner role to verify policy behavior.

## Verification

`rlsAuthorizationBoundaries.integration.test.ts` exercises actual PostgreSQL RLS using non-owner test roles:
- Customer A cannot read Customer B's user row, delivery, payment, or escrow attempt.
- An unassigned driver cannot read a delivery; its assigned driver can.
- Missing subject claims cannot read protected user data.
- A support-like role with SQL INSERT grants still cannot insert payment or escrow-attempt rows because RLS has no write policy.

The API's existing route-level authorization tests remain necessary because the trusted service role bypasses RLS by design.

## Rollout notes

- Apply migration `081_rls_authorization_boundaries.sql` through the migration runner.
- Confirm the production `DATABASE_URL` is a trusted server-only role and never a mobile-app credential.
- Do not add `BYPASSRLS` to end-user or public roles.
- New tables containing user or financial data must receive an explicit policy/default-deny decision in their introducing migration.
