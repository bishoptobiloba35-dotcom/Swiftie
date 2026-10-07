# SwiftDrop Consolidated Production Implementation Prompt

## Mission
Continue the existing Swiftie production application in `bishoptobiloba35-dotcom/Swiftie`. Do not create a prototype, restart the architecture, or merely recommend work. Treat the repository, database migrations, existing APIs, tests, GitHub Actions and already-merged work as the source of truth.

Work in this order for every slice:
CHECK existing implementation and dependencies -> identify the highest-value production blocker -> IMPLEMENT in the existing architecture -> TEST unit/integration/http/database boundaries -> run the actual GitHub Actions workflow -> FIX every failure -> MERGE only after verification -> verify post-merge main CI -> re-audit -> increase launch-readiness only when the requirement is genuinely satisfied.

Never inflate readiness because code exists. Current readiness remains 76% until all gates are earned.

## Product position
SwiftDrop is Nigeria's trust infrastructure for physical transactions.
Tagline: "Move anything. Know where it is. Trust every step."

## Architecture
Preserve the existing Expo/React Native customer production app and existing API/shared/database architecture unless a measured migration is required. Supabase Postgres/Auth/Storage/Realtime remains the storage/auth foundation. Paystack is the payment rail. Google Maps supports location/routing. Termii supports required SMS. PWA/offline foundations may be strengthened, but do not claim Workbox/offline sync is complete until actually implemented and tested.

## Roles
Individual/customer.
Business roles: Merchant, Courier/Driver, Errand, Agent.
Admin roles: Admin, Support, Finance.
Merchant is a first-class business role. Physical merchant locations may also serve as pickup/drop-off stations.

## Core delivery flow
Created -> Paid escrow -> Picked up -> In transit -> Arrived -> PIN confirmed -> dispute window -> released.
Courier payout is never triggered by pickup or arrival. Receiver PIN confirmation is the only escrow-release trigger.

## Cash-flow revision — mandatory
Cash-on-delivery is retired everywhere. No courier, merchant, agent, errand runner or other stakeholder may accept physical cash for an order.

Every order uses in-app escrow. Receiver/customer payment methods are:
- Paystack card
- dedicated Paystack virtual bank account / bank transfer
- USSD
- SMS Paystack payment link

Courier UI shows "Payment secured ✓" only after verified escrow funding.

Every order has an escrow ledger containing total paid, courier share, service charge, protection reserve, SwiftDrop margin and merchant share. Ledger states include pending_payment, paid_escrow, picked_up, in_transit, arrived, pin_confirmed, dispute_window, released, returned, refunded and disputed.

At PIN confirmation:
- courier receives 75% of base fare, subject to successful Paystack transfer/payout eligibility;
- SwiftDrop service/protection/margin remains held for 72 hours;
- merchant share remains held for 72 hours;
- never manufacture a split from client input: calculate it server-side from authoritative order pricing;
- use Paystack Transfers/subaccounts for actual provider settlement.

Stakeholder wallets exist for Courier, Merchant, Agent, Errand Runner and Customer. Balances and pending balances are ledger-backed. Minimum withdrawal is ₦1,000. Withdrawals use Paystack Transfers and must be idempotent.

Virtual accounts:
- provision a unique Paystack dedicated virtual account for the receiver/order;
- display "Transfer ₦X to [account number] ([bank])";
- Paystack charge.success/webhook reconciles the exact order, amount and NGN currency;
- never mark escrow paid from a client callback alone;
- prevent duplicate webhook crediting.

USSD:
- create the Paystack USSD payment path;
- verify only by webhook/provider reconciliation;
- non-smartphone fallback must remain usable.

SMS payment:
- send: "Your parcel #SD-XXXXXX is arriving. Pay ₦2,855: [link]"
- use a short-lived authenticated Paystack payment link;
- do not expose sensitive account data.

Return:
- if receiver refuses required in-app payment, courier taps Return;
- apply 50% of delivery fee as return fee;
- auto-deduct the return fee from the receiver's refundable amount when permitted by the escrow/refund policy;
- credit the return fee to the courier through the wallet/ledger;
- route parcel back to sender;
- never accept cash for the return fee.

Float:
- dedicated escrow float account;
- minimum reserve ₦5,000,000;
- auto-top-up threshold ₦3,000,000;
- daily reconciliation at 18:00;
- record funding, escrow-in/out, payouts, refunds, top-ups and interest income;
- customer funds must not be treated as operating cash;
- admin/Finance-only float dashboard.

## Trust stack
Trust Score formula, recomputed after every completed transaction:
(delivery_success_rate × 0.30) +
(on_time_rate × 0.20) +
(photo_compliance_rate × 0.15) +
(rating_avg_normalized × 0.20) +
((100 - dispute_rate) × 0.15)

New users start at 50.
Display exactly: "Trust Score: 94/100 · Excellent"
Below 70: retraining required.
Below 50: suspend account.
Below 60: agent SLA penalties.
Below 70: merchant reduced Shop visibility.

## Receiver PIN
Exactly four digits.
Generate at order creation.
Send by SMS only.
Never display PIN in-app to sender.
Sender sees "PIN sent ✓".
Store only bcrypt/Argon2 hash.
Three failed attempts -> 15-minute lock -> support escalation.
PIN may be entered on courier or receiver device.
PIN confirmation is the only escrow release trigger.

## Parcel confirmation
Reusable confirmation sheet:
Title: Confirm parcel information
Text: The parcel must carry all of these before it moves:
- Receiver name is on the parcel
- Phone number is on the parcel
- Delivery address is on the parcel
Buttons: [Confirm] [Cancel]
Confirm disabled until all three are selected.

Enforce at courier acceptance, merchant handoff, agent dispatch and errand handoff.

## Exact microcopy
Use these strings verbatim:
"How far? What are we moving today?"
"Sharp sharp! Payment received."
"Finding you an errand…"
"Tunde (verified errand) accepted your request"
"Keep everything in this chat. Phone numbers stay hidden until the goods are paid."
"Photo sent. Customer, review and confirm you're satisfied."
"🔔 New order paid · #SD-XXXX"
"Send out immediately. Parcel must show receiver name, phone & address."
"All orders are sent to a drop-off / pickup station. Only Xpress Drop-off is delivered to your chosen location."
"Payment on delivery: the receiver pays the courier [total]. The courier remits the cash to SwiftDrop within 24 hours."
"💵 Merchant orders are payment on delivery: collect the fee from the receiver. Remit the cash to your wallet within 24h. If the receiver refuses, tap Return and a return fee applies."

Important: the last two historical POD strings must remain only as archived/legacy copy if needed for migration/audit; they must never be presented as an active cash-payment option after the cash-flow revision.

## Errand
Hire an Errand absorbs Buy & Deliver and Shop for Me.
Goods cap ₦50,000.
Minimum errand fee ₦300.
Platform commission 15% of errand fee.
Doorstep surcharge +₦800.
No payment before photo approval.

Deal Card fields:
Item, Quantity, Where to buy, Goods budget, Errand fee, Total auto-calculated.
Runner proposes; Customer accepts.
Stages:
0 matched
1 proposed
2 accepted
3 purchased (runner photo + receipt)
4 paid (customer "I'm satisfied, pay for goods")
5 delivered (PIN confirms and escrow releases)

No unauthorized substitutions. Enforce spending ceiling and exact/acceptable-alternative policy.

## Pricing
Base fare ₦500 + ₦150/km.
Service charge 5% of delivery fee.
Protection reserve 10% declared value, optional but ON by default.
Xpress shop +20%.
Insurance premium ₦500, coverage up to ₦100,000.
Fuel reference uses current Nigerian fuel price × 2 litres, with source/effective timestamp/pricing version/history.
Weekly base-fare fuel adjustment.
Transparent fuel surcharge if fuel spike exceeds 10%.
EV courier discount 10%.
Server-side pricing only.

## Nigeria operational requirements
Landmark required.
Map pin required.
Optional 10-second voice note and entrance photo.
Bank transfer is first-class.
USSD fallback for non-smartphone users.
SMS tracking: "Send TRACK SD123456 to 30222".
English default with Nigerian/Pidgin tone.
High-risk zones are admin-configurable.
High-risk orders require extra verification and mandatory insurance.

## Fraud and controls
Maximum 10 orders/hour/user.
Device fingerprinting at account creation.
Duplicate-order detection.
GPS mismatch between pickup photo and recorded pickup location is flagged.
Dispute rate >20% is flagged.
Courier remittance logic must auto-deduct wallet balances where an applicable legacy/operational remittance is genuinely required, but no new order may require cash remittance.
Audit every financial state transition.

## Courier onboarding
Day 1: KYC + theory (ID, training, code of conduct).
Day 2: shadow 5 deliveries.
Day 3: supervised 3 deliveries + supervisor approval.
No go-live until all three days and KYC approval are complete.

## Support/dispute SLAs
Not delivered: first response 2h, resolution 24h.
Damaged: 4h/48h.
Wrong item: 4h/48h.
Not as described: 4h/48h.
Payment issue: 1h/12h.
Display SLA on dispute form.

## Notifications
Order created; Payment received; Courier assigned; Picked up with photo; In transit; Arrived; PIN request; Delivered; Escrow released; Agent new paid order; Agent SLA warning; Errand accepted; New chat message; Fee proposed; Photo received; Dispute filed; Dispute update; KYC approved/rejected; Low wallet balance; Bank transfer confirmed; Fuel surcharge applied.

Push: all.
In-app: all.
SMS only: PIN request, KYC status, agent new order, dispute filed, low wallet balance.

## Minimum data model
Maintain and reconcile:
users, wallets/wallet_transactions, addresses, stations, delivery_orders/deliveries, order_events, couriers/drivers, products, sellers, carts, shop_orders, agent_notifications, errand_requests, errand_deal_cards, errand_messages, reviews, disputes, kyc_documents, notifications, ai_conversations, trust_events, escrow_ledgers, virtual_accounts, float_transactions, stakeholder_wallets and payout_requests.

Financial tables must use immutable/append-only transaction records where appropriate, idempotency keys, provider references and reconciliation metadata.

## Screens
Individual:
Splash, User Type, Home, Place Your Order, Quote, Escrow Payment, Live Tracking, Pickup Evidence, Receiver PIN, Review, Profile, Order History, Notification Center, Trust Score, Delivery Protection & Escrow, Enhanced Dispute Center, Wallet, Payout Request.

Business:
Home, Orders, Earnings, Profile, Merchant command centre, Courier command centre, Errand command centre, Agent command centre, Business Analytics.

Admin:
Overview, Users, Orders, KYC, Disputes, Payouts, Fees/Zones, Analytics, Float Dashboard, audit/operations.

## Admin
Cards: Total Users, Total Orders, Revenue, Disbursements, Active Drivers, Disputes.
KYC review approve/reject reason.
User search/suspend/verify/history.
Live order monitoring/intervene.
Dispute evidence/arbitration.
Payout approvals.
Fee/zone config.
Analytics: orders over time, top products, courier performance, merchant performance.
Access: Admin full; Support disputes+KYC; Finance payouts+reports+float.

## UI/design
Mobile-first premium grounded Nigerian logistics design:
warm ivory/paper, forest/pine green, sage, stone, muted brass, restrained shadows, real logistics imagery, strong typography.
Avoid generic fintech blue/neon, excessive gradients and fake futuristic AI.
WCAG AA.
Figtree/Inter.
Body >=16px, headings 20–24px, totals 34–38px.
NGN ₦ formatting.
Light/dark/system appearance persisted and instant.

## Security
All payment/escrow/payout calculations server-side.
Verify Paystack webhook signature.
Verify event/reference/amount/currency/order ownership.
Idempotency on checkout, escrow funding, wallet transactions, payout requests and webhook processing.
Never log PINs, card details, secrets or sensitive identity data.
Use authorization boundaries for customer, courier, merchant, agent, errand, Support, Finance and Admin.
Storage is private by default with owner/role-specific access.

## Verification questions
Before declaring this specification complete, prove:
1. Data model matches the required model and migrations are safe.
2. Cash-on-delivery cannot be created, paid, displayed or settled.
3. PIN is exactly four digits and stored hashed.
4. Escrow release can happen only through authenticated PIN confirmation.
5. Trust Score uses the exact formula and consequences.
6. Errand funds cannot be released before photo/receipt approval.
7. Parcel handoff cannot proceed without the three required parcel-information confirmations.
8. Paystack webhook reconciliation is idempotent and amount/currency/reference-bound.
9. Courier payout is 75% of base fare and is actually routed through the wallet/Paystack transfer boundary.
10. Merchant funds are held 72 hours.
11. Float reconciliation runs at 18:00 and preserves an auditable ledger.
12. Withdrawal minimum is ₦1,000 and payout requests are idempotent.
13. No legacy UI or API advertises active cash collection.
14. Actual GitHub Actions CI is green on the final head and post-merge main.
15. Re-audit shows the requirement is actually operational, not merely represented by a database column.

## Recommendations to preserve
Continue proactively identifying production-grade improvements from Nigerian logistics, marketplace, payments and errand competitors, but only adopt features that improve trust, conversion, reliability, unit economics, fraud resistance, operations or differentiation. Prefer:
- evidence-first delivery timelines;
- transparent failure/recovery paths;
- server-authoritative pricing;
- auditable financial ledgers;
- role-based operational command centres;
- high-risk zone controls;
- offline-safe drafts and retryable idempotent actions;
- clear service-level commitments;
- analytics tied to operational decisions;
- customer-facing transparency without exposing sensitive internal data.

Do not add speculative complexity merely to increase a readiness percentage.
