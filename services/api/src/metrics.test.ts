import { strict as assert } from "node:assert";
import test from "node:test";
import { recordHttpMetric, renderPrometheusMetrics, resetHttpMetricsForTests } from "./metrics.js";

test("http metrics aggregate requests and 5xx errors", () => {
  resetHttpMetricsForTests();
  recordHttpMetric("GET", "/api/deliveries/550e8400-e29b-41d4-a716-446655440000", 200, 42);
  recordHttpMetric("GET", "/api/deliveries/550e8400-e29b-41d4-a716-446655440000", 503, 1200);

  const output = renderPrometheusMetrics();
  assert.match(output, /swiftdrop_http_requests_total\{method="GET",path="\/api\/deliveries\/:id"\} 2/);
  assert.match(output, /swiftdrop_http_errors_total\{method="GET",path="\/api\/deliveries\/:id"\} 1/);
  assert.match(output, /le="2500"/);
  assert.match(output, /_count\{method="GET",path="\/api\/deliveries\/:id"\} 2/);
});
