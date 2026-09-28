# SwiftDrop product-flow implementation

This milestone adds the backend foundation for the product prototype's AI and plan model.

## AI safety boundary
AI does not receive direct payment credentials. It can prepare or request actions through the API and the permission policy evaluates whether payment requires explicit user approval.

Modes:
- ASSIST: prepare/recommend; user approval required for consequential actions.
- AUTHORIZED: routine actions can execute within configured limits.
- AUTONOMOUS: predefined workflows can execute within configured limits.

Payment controls include per-transaction automatic-payment limits, daily spending limits and approval thresholds. Every AI action is auditable.

## Plans
The backend now stores individual BASIC/PREMIUM and business NONE/BASIC/PREMIUM plan state. Business accounts and AI dispatch rules are represented separately so the UI can be integrated without conflating personal and business automation.

## Agent foundation
Agent applications are stored with applicant, business, category, address, requested services and approval state. Physical verification/commission settlement remains an operational/admin workflow and is not inferred from application submission.
