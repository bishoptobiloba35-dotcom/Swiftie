# SwiftDrop

Production delivery platform for customers, drivers, agents, receivers, and administrators. Merchant is a partner/drop-off/seller concept, not a SwiftDrop account mode.

## Core delivery lifecycle

`CREATED → PAYMENT_AUTHORIZED → DRIVER_ASSIGNED → DRIVER_AT_PICKUP → PICKED_UP → IN_TRANSIT → ARRIVED → DELIVERED`

## Planned applications

- `apps/customer` — customer mobile app
- `apps/driver` — driver mobile app
- `apps/admin` — admin dashboard
- `services/api` — backend API and delivery engine
- `packages/shared` — shared domain types and validation

The backend is authoritative for delivery state, pricing, GPS events, pickup proof, receiver PIN verification, payment state, and driver payouts.

## Pickup-to-delivery flow

1. Customer creates a delivery and receives a server-calculated quote.
2. Customer authorizes payment.
3. Driver accepts the delivery.
4. Driver reaches pickup and confirms the parcel.
5. Driver takes a mandatory parcel photo; the sender can see the proof.
6. Driver starts the trip and authenticated GPS updates begin.
7. Sender and receiver can follow the parcel and ETA in real time.
8. Receiver provides the delivery PIN.
9. Server verifies the PIN and completes the delivery.
10. Payout is released according to payment/disbursement rules.
11. Ratings, receipts, and delivery history are recorded.

## Security principles

- Server-authoritative state transitions
- Authenticated driver location updates
- Role-based access control
- Secure private document/object storage (Supabase Storage in production; local private storage in development)
- Payment-provider abstraction
- Audit events for sensitive actions
- Secrets supplied through environment variables

## Current financial collection model

Every delivery has an explicit server-side payment mode:

- **Sender pays — SENDER_ESCROW:** the sender pays the quoted total through Paystack; the payment enters the existing held escrow-style ledger and is released for courier payout only after verified receiver PIN confirmation.
- **Receiver pays — RECEIVER_ON_DELIVERY:** the sender does not prepay and no escrow is used. When the courier arrives, the receiver verifies the package with the receiver phone and PIN. SwiftDrop then opens a Paystack checkout for the exact server-authoritative order total. The order is not marked delivered and the courier payout is not eligible until Paystack verifies the receiver payment.
- Receiver-paid collections are reconciled by amount, currency, delivery, payment mode and provider reference. Failed or mismatched payments cannot complete the delivery.
- Marketplace/drop-off merchants remain supported as sellers or SwiftDrop partner locations, but **Merchant is not a user/business mode**.

## Current delivery/payment rules

- Delivery pricing is calculated server-side from road distance, parcel weight, parcel dimensions/volumetric weight, and a disclosed perishable-item surcharge.
- Customer payments enter a held escrow-style ledger after verified payment. The courier cannot complete the delivery alone.
- The receiver confirms receipt with the tracking code, receiver phone and six-digit PIN. Only then is the held payment marked released and the courier payout becomes eligible.
- Only drivers with approved KYC can see, accept or receive delivery jobs. Approved drivers are automatically set online when they sign in.
- Both the sender and receiver can review the courier after delivery; drivers can also review senders.

**Payment note:** the current release is an application-level held/release ledger around the Paystack payment flow. Actual automated bank transfer to a courier requires the courier's verified payout recipient details and the Paystack Transfers integration before production launch.


## Production environment

The API requires, in production, a PostgreSQL `DATABASE_URL`, strong `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, HTTPS `CORS_ORIGINS`, and private Supabase Storage credentials:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_STORAGE_BUCKET` (private bucket)

Pickup evidence and driver KYC files are never served from a public uploads directory.

## Business automation

Business Premium users with authorized dispatch roles can create recurring dispatch rules. The API validates business membership and limits, stores the rule, and a server worker generates an auditable dispatch plan when the rule is due.