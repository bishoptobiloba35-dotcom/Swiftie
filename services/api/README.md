# SwiftDrop API

The API will own authentication, delivery lifecycle transitions, quotes, driver assignment, GPS events, pickup evidence, receiver PIN verification, payment state and notifications.

All sensitive state transitions must be validated server-side.

Initial API modules:
- auth
- users
- drivers
- deliveries
- quotes
- tracking
- payments
- notifications
- disputes
