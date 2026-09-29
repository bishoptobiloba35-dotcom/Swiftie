export type SupportAiDecision = "AUTO_RESOLVED" | "ESCALATED";

const unsafePatterns = /(refund|refunds|payment|paystack|cancel|cancellation|payout|transfer|chargeback|dispute|money|wallet|bank)/i;
const informationalPatterns = /(how|where|track|tracking|support|help|status|app|driver|drop.?off)/i;

export function classifySupportRequest(subject: string, message: string): SupportAiDecision {
  const text = subject + " " + message;
  if (unsafePatterns.test(text)) return "ESCALATED";
  if (informationalPatterns.test(text)) return "AUTO_RESOLVED";
  return "ESCALATED";
}
