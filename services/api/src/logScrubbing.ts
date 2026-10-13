const SENSITIVE_FIELD = /^(?:pin|receiverpin|receiver_pin|cardnumber|card_number|accountnumber|account_number|bankaccountnumber|bank_account_number|authorization|accesstoken|access_token|apikey|api_key|secretkey|secret_key|token)$/i;

/**
 * Redact credential/payment identifiers from text before it reaches any console
 * or structured error sink. PINs are intentionally redacted as any standalone
 * four-digit sequence because log call sites cannot reliably identify which
 * values originated from receiver-PIN generation.
 */
export function redactSensitiveLogText(value: string): string {
  return value
    .replace(/\b(?:\d[ -]?){15}\d\b/g, "[REDACTED_CARD_NUMBER]")
    .replace(/\b\d{10}\b/g, "[REDACTED_BANK_ACCOUNT]")
    .replace(/\b(?:sk_live_|pk_live_|sk_test_)[A-Za-z0-9_-]*\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/(?<!\d)\d{4}(?!\d)/g, "[REDACTED_PIN]");
}

function redactLogValue(value: unknown, fieldName?: string): unknown {
  if (fieldName && SENSITIVE_FIELD.test(fieldName)) return "[REDACTED]";
  if (typeof value === "string") return redactSensitiveLogText(value);
  if (Array.isArray(value)) return value.map(item => redactLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactLogValue(nested, key)
      ])
    );
  }
  return value;
}

let restoreInstalledScrubber: (() => void) | null = null;

/**
 * Install once at process startup. The returned callback exists for isolated
 * tests; production startup intentionally keeps the scrubber installed.
 */
export function installLogScrubbing(): () => void {
  if (restoreInstalledScrubber) return restoreInstalledScrubber;

  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, (...args: unknown[]) => void>();

  for (const method of methods) {
    const original = target[method].bind(console);
    originals.set(method, original);
    target[method] = (...args: unknown[]) => original(...args.map(value => redactLogValue(value)));
  }

  const restore = () => {
    for (const [method, original] of originals) target[method] = original;
    if (restoreInstalledScrubber === restore) restoreInstalledScrubber = null;
  };
  restoreInstalledScrubber = restore;
  return restore;
}
