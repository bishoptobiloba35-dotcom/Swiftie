export type DriverPayoutMode = "standard" | "instant";

export function calculatePayoutFeeMinor(amountMinor: number, mode: DriverPayoutMode): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("Payout amount must be a positive integer in minor units");
  if (mode === "standard") return 0;
  return Math.min(50_000, Math.max(5_000, Math.ceil(amountMinor * 0.01)));
}

function nameParts(value: string): string[] {
  const honorifics = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "chief", "alhaji", "alhaja", "hon", "sir", "madam"]);
  return value.toLocaleLowerCase("en-NG").replace(/[^a-z\\s'-]/g, " ").split(/[\\s'-]+/)
    .filter(Boolean).filter(part => !honorifics.has(part));
}

export function payoutAccountNameMatches(legalName: string, resolvedName: string): boolean {
  const legal = nameParts(legalName);
  const resolved = nameParts(resolvedName);
  if (legal.length < 2 || resolved.length < 2) return false;
  // First and last names must match; middle names and honorifics are ignored.
  return legal[0] === resolved[0] && legal[legal.length - 1] === resolved[resolved.length - 1];
}
