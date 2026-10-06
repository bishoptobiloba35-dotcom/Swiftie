type MetricKey = string;

type RequestMetric = {
  count: number;
  errorCount: number;
  totalDurationMs: number;
  buckets: number[];
};

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000];
const metrics = new Map<MetricKey, RequestMetric>();

function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\b[0-9]{3,}\b/g, ":id");
}

function key(method: string, path: string): MetricKey {
  return method.toUpperCase() + " " + normalizePath(path);
}

export function recordHttpMetric(method: string, path: string, status: number, durationMs: number): void {
  const metricKey = key(method, path);
  const current = metrics.get(metricKey) ?? {
    count: 0,
    errorCount: 0,
    totalDurationMs: 0,
    buckets: Array(LATENCY_BUCKETS_MS.length).fill(0)
  };

  current.count += 1;
  if (status >= 500) current.errorCount += 1;
  current.totalDurationMs += durationMs;

  for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
    if (durationMs <= LATENCY_BUCKETS_MS[index]) current.buckets[index] += 1;
  }

  metrics.set(metricKey, current);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function renderPrometheusMetrics(): string {
  const lines = [
    "# HELP swiftdrop_http_requests_total Total HTTP requests handled by the API.",
    "# TYPE swiftdrop_http_requests_total counter",
    "# HELP swiftdrop_http_errors_total HTTP requests returning a 5xx response.",
    "# TYPE swiftdrop_http_errors_total counter",
    "# HELP swiftdrop_http_request_duration_ms HTTP request duration in milliseconds.",
    "# TYPE swiftdrop_http_request_duration_ms histogram"
  ];

  for (const [metricKey, metric] of metrics) {
    const separator = metricKey.indexOf(" ");
    const method = metricKey.slice(0, separator);
    const path = metricKey.slice(separator + 1);
    const labels = `method="${escapeLabel(method)}",path="${escapeLabel(path)}"`;

    lines.push(`swiftdrop_http_requests_total{${labels}} ${metric.count}`);
    lines.push(`swiftdrop_http_errors_total{${labels}} ${metric.errorCount}`);

    let cumulative = 0;
    for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
      cumulative = metric.buckets[index];
      lines.push(`swiftdrop_http_request_duration_ms_bucket{${labels},le="${LATENCY_BUCKETS_MS[index]}"} ${cumulative}`);
    }
    lines.push(`swiftdrop_http_request_duration_ms_bucket{${labels},le="+Inf"} ${metric.count}`);
    lines.push(`swiftdrop_http_request_duration_ms_sum{${labels}} ${metric.totalDurationMs}`);
    lines.push(`swiftdrop_http_request_duration_ms_count{${labels}} ${metric.count}`);
  }

  return lines.join("\n") + "\n";
}

export function resetHttpMetricsForTests(): void {
  metrics.clear();
}
