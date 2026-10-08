export type SwiftDropFeature =
  | "RECEIVER_ESCROW"
  | "STANDARD_DELIVERY"
  | "MARKETPLACE"
  | "ERRANDS"
  | "AI"
  | "SUBSCRIPTIONS"
  | "MULTI_STOP"
  | "RECURRING_DELIVERIES"
  | "CORPORATE_ACCOUNTS"
  | "REFERRALS"
  | "IN_APP_CHAT"
  | "DARK_MODE"
  | "PUBLIC_TRACKING"
  | "INTER_STATE"
  | "EV_DISCOUNT"
  | "HIGH_RISK_ZONES"
  | "SEPARATE_INSURANCE";

const envName = (feature: SwiftDropFeature): string =>
  "SWIFTDROP_ENABLE_" + feature;

export function featureEnabled(feature: SwiftDropFeature): boolean {
  return process.env[envName(feature)] === "true";
}

export function assertFeatureEnabled(feature: SwiftDropFeature): void {
  if (!featureEnabled(feature)) {
    throw new Error("Feature " + feature + " is disabled");
  }
}
