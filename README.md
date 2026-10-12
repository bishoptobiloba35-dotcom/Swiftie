# SwiftDrop

Production-grade logistics and physical-commerce platform for Nigeria.
Every line of code must work with real money, real riders, real parcels, and real customers.

Repository: bishoptobiloba35-dotcom/Swiftie  
Stack: Expo / React Native · Supabase · Paystack · Terminal Africa · Nigerian SMS · Google Maps

## Core product rules (never violate)

1. **Merchant mode stays.** Merchant is a first-class role. Merchants can sell goods, manage orders, use pickup/drop-off locations, and access a command centre.
2. **Digital pay-on-delivery stays.** The receiver can pay digitally at delivery (card, transfer, or USSD through the app).
3. **Cash never touches the courier.** No cash controls in the courier app. No cash remittance workflow. No exceptions.
4. **Server verifies every payment.** A separate `PAY_ON_DELIVERY` payment option with a server-controlled `RECEIVER_PAYMENT_PENDING` state. Payment is only confirmed via webhook verification.
5. **Escrow applies where configured.** If escrow policy applies to POD orders, funds follow the escrow flow.

## Payment modes

| Mode              | Who pays          | When                          | Cash? |
|-------------------|-------------------|-------------------------------|-------|
| `SENDER_ESCROW`   | Sender            | At order creation             | No    |
| `RECEIVER_ESCROW` | Receiver          | Before handover               | No    |
| `PAY_ON_DELIVERY` | Receiver (digital)| At delivery (in-app)          | No    |

### Pay-on-delivery lifecycle

```
Order created
    → PAYMENT_PENDING
    → Courier assigned
    → Picked up
    → In transit
    → Arrived
    → RECEIVER_PAYMENT_PENDING   ← receiver opens app, sees amount, pays
    → PAYMENT_VERIFIED           ← only via Paystack webhook
    → HANDED_OVER
    → PIN_CONFIRMED
    → DELIVERED
    → DISPUTE_WINDOW
    → RELEASED
    → COURIER_PAID
```

Rules:
- Courier never collects cash
- Client never marks payment as complete
- Server verifies via webhook before any state change
- If escrow applies, funds follow the escrow flow

## Core delivery lifecycle (SENDER_ESCROW)

`CREATED → PAYMENT_AUTHORIZED → DRIVER_ASSIGNED → DRIVER_AT_PICKUP → PICKED_UP → IN_TRANSIT → ARRIVED → DELIVERED`

## Planned applications

- `apps/customer` — customer mobile app
- `apps/driver` — driver mobile app
- `apps/admin` — admin dashboard
- `services/api` — backend API and delivery engine
- `packages/shared` — shared domain types and validation

The backend is authoritative for delivery state, pricing, GPS events, pickup proof, receiver PIN verification, payment state, and driver payouts.

## Security principles

- Server-authoritative state transitions
- Authenticated driver location updates
- Role-based access control
- Secure private document/object storage
- Payment-provider abstraction
- Audit events for sensitive actions
- Secrets supplied through environment variables

## Current financial collection model

- **SENDER_ESCROW** (default): sender pays the exact server-authoritative quoted total through Paystack; funds remain in escrow; courier payout is eligible only after successful delivery confirmation via receiver PIN.
- **PAY_ON_DELIVERY** (digital): receiver pays digitally at delivery. Status moves to `RECEIVER_PAYMENT_PENDING`; only a verified Paystack webhook can set `PAYMENT_VERIFIED`. Cash is rejected at both application and database boundaries.

**Payment note:** Actual automated bank transfer to a courier requires the courier's verified payout recipient details and the Paystack Transfers integration before production launch.

## Production environment

The API requires, in production, a PostgreSQL `DATABASE_URL`, strong `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, HTTPS `CORS_ORIGINS`, and private Supabase Storage credentials:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET` (private bucket)

Pickup evidence and driver KYC files are never served from a public uploads directory.

## Feature flags (server-enforced)

When a flag is off the capability returns **403**, not merely hidden in the UI.

| Flag             | Default | Purpose                                      |
|------------------|---------|----------------------------------------------|
| marketplace      | OFF     | Product listings, checkout, seller settlement|
| errands          | OFF     | Hire an Errand, Buy & Deliver, Shop for Me   |
| pod              | ON      | Digital pay-on-delivery                      |
| receiver_escrow  | OFF     | Receiver pays before handover                |
| partner_api      | OFF     | Terminal Africa / Shipbubble integration     |
| white_label      | OFF     | SaaS for smaller operators                   |
| agent_network    | OFF     | Agent pickup/drop-off points                 |
| swift_ai         | OFF     | AI assistant                                 |
| multi_stop       | OFF     | Multi-stop errands                           |
| inter_state      | ON      | Inter-state delivery                         |

## Build order

1. Phase 0 — Foundation: users, roles, migrations, RLS, storage, Paystack skeleton, CI
2. Phase 1 — Order flow: Send Package, server quote, payment, escrow funding
3. Phase 2 — Courier flow: KYC, assignment, pickup evidence, tracking
4. Phase 3 — PIN and completion: receiver PIN, evidence, dispute window, release
5. Phase 4 — POD: pay-on-delivery option, server-controlled pending state, webhook verification
6. Phase 5 — Partner API: Terminal Africa / Shipbubble integration
7. Phase 6 — Merchant mode: listings, inventory, orders, settlement
8. Phase 7 — Hardening: feature flags, error handling, offline safety, pilot prep

**Do not proceed to Phase 2 until Phase 1 is fully working, tested, and merged.**

## Definition of done

A feature is complete only when:

1. Product requirement met
2. Database model and migration safe
3. Server rules and RLS enforce it
4. Financial implications handled
5. Frontend exposes workflow and failure states
6. Security controls exist
7. Tests pass
8. Branch CI green
9. Merged to main, main CI green
10. Post-merge verified
11. Re-audited
12. No placeholders, dead buttons, fake data, or unexplained errors on the critical path
