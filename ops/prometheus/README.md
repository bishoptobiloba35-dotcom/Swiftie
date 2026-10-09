# SwiftDrop API operational alerts

These rules are designed for Prometheus-compatible alerting (for example, Prometheus + Alertmanager). They consume the authenticated /metrics endpoint and intentionally use only low-cardinality method/path labels.

## Required scrape

Configure the monitoring system to scrape the API /metrics endpoint. Supply the token from a secret file or secret manager; do not put the token in this repository or a public scrape configuration.

The API requires this header:

```
Authorization: Bearer <METRICS_TOKEN>
```

The API returns 404 when the token is missing or incorrect. Verify the scrape target is UP after configuring authentication.

## Alerts

- **SwiftDropApiHigh5xxRate**: critical when non-operational API 5xx responses exceed 5% for 10 minutes.
- **SwiftDropApiHighLatency**: warning when p95 non-operational API request latency exceeds 2.5 seconds for 10 minutes.
- **SwiftDropApiNoTraffic**: warning when no application requests are observed for 30 minutes, or the application request metric disappears.

The rules exclude /metrics, /health and /ready so Prometheus scrapes and health probes do not falsely count as customer/business traffic or mask an idle application. The no-traffic rule handles both a zero request rate and an absent request metric.

## Required production handoff

1. Install these rules in the production Prometheus configuration and validate them with the deployed Prometheus version before reload.
2. Configure Alertmanager (or the chosen monitoring service) to route critical alerts to the on-call owner and warnings to the agreed operations channel.
3. Use the secret manager for METRICS_TOKEN and the alert destination credentials.
4. Trigger a controlled test alert and verify that the intended human receives it; record the test date and owner in the operations runbook.
5. Test the alert route after any monitoring, deployment, or credential change.

Route-specific alerting can be added later only when there is a demonstrated operational need. Avoid high-cardinality labels such as request IDs, users, emails, coordinates, or payment references.

These rules are configuration artifacts, not a hosted monitoring service. A production deployment is not considered monitored until the scrape, alert evaluation, notification route and human receipt have all been verified.
