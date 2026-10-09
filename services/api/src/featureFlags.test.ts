import test from "node:test";
import assert from "node:assert/strict";
import { featureEnabled, assertFeatureAndLegalGate } from "./featureFlags.js";
import { legalGateEnabled } from "./legalGates.js";

function withCleanEnv(names: string[], run: () => void): void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("MVP v1.2 Phase 2 feature flags are off unless explicitly enabled", () => {
  withCleanEnv([
    "SWIFTDROP_ENABLE_MARKETPLACE",
    "SWIFTDROP_ENABLE_ERRANDS",
    "SWIFTDROP_ENABLE_AI"
  ], () => {
    assert.equal(featureEnabled("MARKETPLACE"), false);
    assert.equal(featureEnabled("ERRANDS"), false);
    assert.equal(featureEnabled("AI"), false);
  });
});

test("receiver escrow and standard delivery require both feature and matching legal gates", () => {
  withCleanEnv([
    "SWIFTDROP_ENABLE_RECEIVER_ESCROW",
    "SWIFTDROP_ENABLE_STANDARD_DELIVERY",
    "SWIFTDROP_LEGAL_GATE_LICENSED_ESCROW_PARTNER",
    "SWIFTDROP_LEGAL_GATE_STATION_AGENT_LIABILITY"
  ], () => {
    process.env.SWIFTDROP_ENABLE_RECEIVER_ESCROW = "true";
    process.env.SWIFTDROP_ENABLE_STANDARD_DELIVERY = "true";

    assert.equal(featureEnabled("RECEIVER_ESCROW"), false);
    assert.equal(featureEnabled("STANDARD_DELIVERY"), false);
    assert.equal(legalGateEnabled("LICENSED_ESCROW_PARTNER"), false);
    assert.equal(legalGateEnabled("STATION_AGENT_LIABILITY"), false);
    assert.throws(
      () => assertFeatureAndLegalGate("RECEIVER_ESCROW", "LICENSED_ESCROW_PARTNER"),
      /Legal gate/
    );

    process.env.SWIFTDROP_LEGAL_GATE_STATION_AGENT_LIABILITY = "true";
    assert.throws(
      () => assertFeatureAndLegalGate("RECEIVER_ESCROW", "STATION_AGENT_LIABILITY"),
      /requires legal gate LICENSED_ESCROW_PARTNER/
    );
    assert.equal(featureEnabled("RECEIVER_ESCROW"), false);

    process.env.SWIFTDROP_LEGAL_GATE_LICENSED_ESCROW_PARTNER = "true";
    assert.equal(featureEnabled("RECEIVER_ESCROW"), true);
    assert.equal(featureEnabled("STANDARD_DELIVERY"), true);
    assert.doesNotThrow(() => assertFeatureAndLegalGate("RECEIVER_ESCROW", "LICENSED_ESCROW_PARTNER"));
    assert.doesNotThrow(() => assertFeatureAndLegalGate("STANDARD_DELIVERY", "STATION_AGENT_LIABILITY"));
  });
});

test("dormant production capabilities are disabled by default", () => {
  withCleanEnv([
    "SWIFTDROP_ENABLE_AGENT_ROLE",
    "SWIFTDROP_ENABLE_CORPORATE_ACCOUNTS",
    "SWIFTDROP_ENABLE_RECURRING_DELIVERIES"
  ], () => {
    assert.equal(featureEnabled("AGENT_ROLE"), false);
    assert.equal(featureEnabled("CORPORATE_ACCOUNTS"), false);
    assert.equal(featureEnabled("RECURRING_DELIVERIES"), false);
  });
});

// Server-gated dormant capability coverage intentionally remains opt-in.
// Path-scoped gates are verified by integration CI.
