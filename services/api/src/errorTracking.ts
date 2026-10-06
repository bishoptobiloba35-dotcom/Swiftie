export type ExternalErrorEvent = {
  event: "swiftdrop.api.error";
  requestId?: string;
  method: string;
  path: string;
  status: number;
  errorType: string;
  message: string;
  timestamp: string;
};

function configuredWebhook(): URL | null {
  const raw = process.env.ERROR_TRACKING_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function buildExternalErrorEvent(input: {
  requestId?: string;
  method: string;
  path: string;
  status: number;
  error: unknown;
  timestamp?: string;
}): ExternalErrorEvent {
  const error = input.error instanceof Error ? input.error : new Error("Unknown server error");
  return {
    event: "swiftdrop.api.error",
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    errorType: error.name || "Error",
    message: error.message.slice(0, 1000),
    timestamp: input.timestamp ?? new Date().toISOString()
  };
}

export async function reportExternalError(input: Parameters<typeof buildExternalErrorEvent>[0]): Promise<void> {
  const webhook = configuredWebhook();
  if (!webhook) return;

  const event = buildExternalErrorEvent(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.ERROR_TRACKING_WEBHOOK_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal: controller.signal
    });
  } catch {
    // Error reporting must never turn an API failure into a second failure.
  } finally {
    clearTimeout(timeout);
  }
}
