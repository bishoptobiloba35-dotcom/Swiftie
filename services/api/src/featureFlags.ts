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
  | "SEPARATE_INSURANCE"
  | "AGENT_ROLE";

const envName = (feature: SwiftDropFeature): string =>
  "SWIFTDROP_ENABLE_" + feature;

export function featureEnabled(feature: SwiftDropFeature): boolean {
  return process.env[envName(feature)] === "true";
}

import { legalGateEnabled, type LegalGate } from "./legalGates.js";

export function assertFeatureAndLegalGate(feature: SwiftDropFeature, gate: LegalGate): void {
  if (!featureEnabled(feature)) throw new Error("Feature " + feature + " is disabled");
  if (!legalGateEnabled(gate)) throw new Error("Legal gate " + gate + " is not enabled");
}

export function assertFeatureEnabled(feature: SwiftDropFeature): void {
  if (!featureEnabled(feature)) {
    throw new Error("Feature " + feature + " is disabled");
  }
}
