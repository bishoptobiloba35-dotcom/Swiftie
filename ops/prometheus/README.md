# SwiftDrop API operational alerts

These rules are designed for Prometheus-compatible alerting (for example, Prometheus + Alertmanager). They consume the authenticated `/metrics` endpoint and intentionally use only low-cardinality method/path labels.

## Required scrape

Configure the monitoring system to scrape the API `/metrics` endpoint with:

```
Authorization: Bearer <METRICS_TOKEN>
```

The API returns 404 when the token is missing or incorrect.

## Alerts

- **SwiftDropApiHigh5xxRate**: critical when 5xx responses exceed 5% for 10 minutes.
- **SwiftDropApiHighLatency**: warning when p95 request latency exceeds 2.5 seconds for 10 minutes.
- **SwiftDropApiNoTraffic**: warning when no requests are observed for 30 minutes.

Route-specific alerting can be added later only when there is a demonstrated operational need; avoid high-cardinality labels such as request IDs, users, emails, coordinates, or payment references.

These rules are configuration artifacts, not a hosted monitoring service. A production deployment must connect them to Prometheus/Alertmanager (or an equivalent monitoring platform) and a controlled on-call notification channel.
