# Mobile production release gate

Both Expo apps have store distribution profiles. Before an actual store build:

1. Set `EXPO_PUBLIC_API_URL` to the real HTTPS production API URL in the EAS environment for the `production` profile.
2. Set the real Google Maps key in the EAS environment; never commit it.
3. Set the final iOS bundle identifiers and Android package names if the operator has chosen identifiers different from the repository defaults.
4. Configure the EAS project/owner and notification credentials in the operator's EAS account.
5. Run production configuration validation and a production EAS build for **both** customer and driver apps.
6. Install the release candidates on physical iOS and Android devices and verify authentication, push notifications, maps, location permissions, tracking, photo/document upload, and payment flows.
7. Complete App Store Connect and Google Play privacy/data-safety declarations using the reviewed legal notice and actual production data flows.
8. Obtain Nigerian privacy/legal review of the privacy notice, terms, acceptable-use rules, retention schedule, prohibited-items policy, refunds/cancellations, and operator identity before public launch.

CI validates that production-mode Expo configuration rejects missing/example API endpoints. CI does not claim that store credentials, EAS projects, push certificates, or provider accounts exist.
