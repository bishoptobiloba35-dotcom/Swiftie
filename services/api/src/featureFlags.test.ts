import test from "node:test";
import assert from "node:assert/strict";
import { featureEnabled, assertFeatureAndLegalGate } from "./featureFlags.js";
import { legalGateEnabled } from "./legalGates.js";

test("MVP v1.2 Phase 2 feature flags are off unless explicitly enabled", () => {
  delete process.env.SWIFTDROP_ENABLE_MARKETPLACE;
  delete process.env.SWIFTDROP_ENABLE_ERRANDS;
  delete process.env.SWIFTDROP_ENABLE_AI;
  assert.equal(featureEnabled("MARKETPLACE"), false);
  assert.equal(featureEnabled("ERRANDS"), false);
  assert.equal(featureEnabled("AI"), false);
});

test("receiver escrow and standard delivery require both feature and legal gates", () => {
  process.env.SWIFTDROP_ENABLE_RECEIVER_ESCROW = "true";
  process.env.SWIFTDROP_ENABLE_STANDARD_DELIVERY = "true";
  delete process.env.SWIFTDROP_LEGAL_GATE_LICENSED_ESCROW_PARTNER;
  delete process.env.SWIFTDROP_LEGAL_GATE_STATION_AGENT_LIABILITY;

  assert.equal(featureEnabled("RECEIVER_ESCROW"), false);
  assert.equal(featureEnabled("STANDARD_DELIVERY"), false);
  assert.equal(legalGateEnabled("LICENSED_ESCROW_PARTNER"), false);
  assert.equal(legalGateEnabled("STATION_AGENT_LIABILITY"), false);
  assert.throws(
    () => assertFeatureAndLegalGate("RECEIVER_ESCROW", "LICENSED_ESCROW_PARTNER"),
    /Legal gate/
  );

  process.env.SWIFTDROP_LEGAL_GATE_LICENSED_ESCROW_PARTNER = "true";
  process.env.SWIFTDROP_LEGAL_GATE_STATION_AGENT_LIABILITY = "true";

  assert.equal(featureEnabled("RECEIVER_ESCROW"), true);
  assert.equal(featureEnabled("STANDARD_DELIVERY"), true);
  assert.doesNotThrow(() => assertFeatureAndLegalGate("RECEIVER_ESCROW", "LICENSED_ESCROW_PARTNER"));
  assert.doesNotThrow(() => assertFeatureAndLegalGate("STANDARD_DELIVERY", "STATION_AGENT_LIABILITY"));

  delete process.env.SWIFTDROP_ENABLE_RECEIVER_ESCROW;
  delete process.env.SWIFTDROP_ENABLE_STANDARD_DELIVERY;
  delete process.env.SWIFTDROP_LEGAL_GATE_LICENSED_ESCROW_PARTNER;
  delete process.env.SWIFTDROP_LEGAL_GATE_STATION_AGENT_LIABILITY;
});

test("dormant production capabilities are disabled by default", () => {
  delete process.env.SWIFTDROP_ENABLE_AGENT_ROLE;
  delete process.env.SWIFTDROP_ENABLE_CORPORATE_ACCOUNTS;
  delete process.env.SWIFTDROP_ENABLE_RECURRING_DELIVERIES;
  assert.equal(featureEnabled("AGENT_ROLE"), false);
  assert.equal(featureEnabled("CORPORATE_ACCOUNTS"), false);
  assert.equal(featureEnabled("RECURRING_DELIVERIES"), false);
});

// Server-gated dormant capability coverage intentionally remains opt-in.
// Path-scoped gates are verified by integration CI.
