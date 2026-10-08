# SwiftDrop Legal & Regulatory Gates

| Gate | Owner | Status | Evidence | Date | Modules blocked while open |
|---|---|---|---|---|---|
| Station-agent onboarding and liability for held parcels | Operations / Legal | OPEN | Not yet supplied | 2026-10-08 | STANDARD station collection |
| Licensed escrow partner agreement covering receiver collection and multi-party settlement | Finance / Legal | OPEN | Not yet supplied | 2026-10-08 | RECEIVER_ESCROW real-money settlement |
| NIPOST courier licence/category and fees | Operations / Legal | OPEN | Current regulator evidence required | 2026-10-08 | Courier launch |
| NHIA health-insurance compliance for couriers | Legal / Operations | OPEN | Current regulator evidence required | 2026-10-08 | Courier launch |
| NDPC registration/privacy/retention-deletion policy | Legal / Privacy | OPEN | Registration and policy evidence required | 2026-10-08 | KYC, evidence, location and receiver-phone processing |
| Terms covering liability, compensation limits and receiver-pays conditions | Legal | OPEN | Signed/current terms required | 2026-10-08 | Production receiver-pays launch |
| Courier accident and goods-loss liability arrangements | Legal / Operations | OPEN | Policy/contract evidence required | 2026-10-08 | Courier launch |

A gate may block only the dependent module. Engineering may complete interfaces, mocks and tests behind production-off controls while a gate is open. Production startup must reject an escrow mock implementation.
