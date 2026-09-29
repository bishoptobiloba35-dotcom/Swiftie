export const unsafeSupportRequestPattern = /(refund|refunds|payment|paystack|cancel|cancellation|payout|transfer|chargeback|dispute|money|wallet|bank)/i;

const safeInformationalSupportPatterns = [
  /\bwhere\s+(?:is|are)\b.*\b(?:order|parcel|delivery|driver)\b/i,
  /\b(?:track|tracking)\b.*\b(?:order|parcel|delivery)\b/i,
  /\b(?:order|parcel|delivery)\b.*\b(?:track|tracking|status|location|where)\b/i,
  /\b(?:what|how)\s+(?:is|does|do)\b.*\b(?:status|tracking)\b/i,
  /\bhow\s+(?:do|can)\s+i\s+(?:track|use|navigate|find)\b/i,
  /\b(?:app|driver|drop[- ]?off)\b.*\b(?:work|works|mean|means|find|locate|use)\b/i,
  /\b(?:contact|reach|talk to)\b.*\b(?:support|help)\b/i
];

export function isSafeInformationalSupportRequest(subject: string, message: string): boolean {
  const text = subject + " " + message;
  return safeInformationalSupportPatterns.some(pattern => pattern.test(text));
}
