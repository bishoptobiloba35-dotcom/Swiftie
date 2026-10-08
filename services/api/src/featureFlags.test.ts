import test from "node:test";
import assert from "node:assert/strict";
import { featureEnabled } from "./featureFlags.js";

test("MVP v1.2 Phase 2 feature flags are off unless explicitly enabled", () => {
  delete process.env.SWIFTDROP_ENABLE_MARKETPLACE;
  delete process.env.SWIFTDROP_ENABLE_ERRANDS;
  delete process.env.SWIFTDROP_ENABLE_AI;
  assert.equal(featureEnabled("MARKETPLACE"), false);
  assert.equal(featureEnabled("ERRANDS"), false);
  assert.equal(featureEnabled("AI"), false);
});

test("receiver escrow and standard delivery are independently flaggable", () => {
  process.env.SWIFTDROP_ENABLE_RECEIVER_ESCROW = "true";
  process.env.SWIFTDROP_ENABLE_STANDARD_DELIVERY = "true";
  assert.equal(featureEnabled("RECEIVER_ESCROW"), true);
  assert.equal(featureEnabled("STANDARD_DELIVERY"), true);
  delete process.env.SWIFTDROP_ENABLE_RECEIVER_ESCROW;
  delete process.env.SWIFTDROP_ENABLE_STANDARD_DELIVERY;
});
