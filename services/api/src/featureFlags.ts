import { legalGateEnabled, type LegalGate } from "./legalGates.js";

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

const legalGateForFeature: Partial<Record<SwiftDropFeature, LegalGate>> = {
  RECEIVER_ESCROW: "LICENSED_ESCROW_PARTNER",
  STANDARD_DELIVERY: "STATION_AGENT_LIABILITY"
};

export function featureEnabled(feature: SwiftDropFeature): boolean {
  if (process.env[envName(feature)] !== "true") return false;
  const gate = legalGateForFeature[feature];
  return gate ? legalGateEnabled(gate) : true;
}

export function assertFeatureAndLegalGate(feature: SwiftDropFeature, gate: LegalGate): void {
  if (process.env[envName(feature)] !== "true") {
    throw new Error("Feature " + feature + " is disabled");
  }
  const requiredGate = legalGateForFeature[feature];
  if (requiredGate && requiredGate !== gate) {
    throw new Error("Feature " + feature + " requires legal gate " + requiredGate);
  }
  if (!legalGateEnabled(gate)) {
    throw new Error("Legal gate " + gate + " is not enabled");
  }
}

export function assertFeatureEnabled(feature: SwiftDropFeature): void {
  if (!featureEnabled(feature)) {
    throw new Error("Feature " + feature + " is disabled");
  }
}
