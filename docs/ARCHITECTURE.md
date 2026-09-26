# SwiftDrop Production Architecture

## Product surfaces

### Customer mobile app
- Account creation and authentication
- Pickup/drop-off address selection
- Server-calculated delivery quote
- Payment authorization
- Delivery history
- Live tracking
- Driver information and ETA
- Receiver PIN
- Proof of delivery
- Ratings and support

### Driver mobile app
- Registration and KYC
- Vehicle profile
- Availability toggle
- Nearby delivery jobs
- Job acceptance
- Navigation to pickup
- Mandatory parcel photo at pickup
- Pickup confirmation
- Authenticated GPS updates
- Delivery PIN verification
- Earnings and withdrawal history
- Incident reporting

### Admin dashboard
- Customer and driver management
- KYC review
- Delivery monitoring
- Pricing and commission configuration
- Payment and payout monitoring
- Disputes/refunds
- Audit and security controls

## Server authority

The API is the source of truth for:
- delivery status transitions
- pricing
- driver assignment
- payment state
- receiver PIN generation and verification
- pickup proof
- driver payout eligibility

Clients cannot directly mark a delivery as picked up or delivered.

## Tracking

After pickup confirmation, the driver app sends authenticated location events. The API validates the driver is assigned to the delivery, stores the latest location and publishes updates to authorized tracking subscribers.

The customer and receiver receive location/ETA updates without being able to modify the driver's location or delivery state.

## Payments

Payment logic is isolated behind a provider adapter so the application can support the selected Nigerian payment provider without coupling the delivery domain to one vendor.

Payment states should include authorization/holding, captured/settled, failed, refunded and payout released.

## Evidence and disputes

Pickup photos, delivery events, PIN verification and relevant audit events are retained as delivery evidence. Access must be role-controlled.

## Suggested stack

- React Native / Expo for customer and driver mobile apps
- TypeScript
- Node.js API
- PostgreSQL
- Redis for queues/cache/realtime support
- WebSocket or SSE for live tracking
- Object storage for KYC and parcel photos
- Maps provider abstraction for geocoding, distance, routing and ETA
- Payment provider abstraction
- Push notifications

The first implementation should prioritize one complete delivery journey from quote to PIN-confirmed delivery before expanding into advanced features.
