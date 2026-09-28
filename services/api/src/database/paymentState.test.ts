import test from "node:test";
import assert from "node:assert/strict";
import { canTransitionPaymentStatus } from "./paymentState.js";

test("payment state transitions allow idempotent and forward webhook states", () => {
  assert.equal(canTransitionPaymentStatus("PENDING", "AUTHORIZED"), true);
  assert.equal(canTransitionPaymentStatus("AUTHORIZED", "HELD"), true);
  assert.equal(canTransitionPaymentStatus("HELD", "RELEASED"), true);
  assert.equal(canTransitionPaymentStatus("HELD", "REFUNDED"), true);
  assert.equal(canTransitionPaymentStatus("PENDING", "FAILED"), true);
  assert.equal(canTransitionPaymentStatus("HELD", "HELD"), true);
});

test("payment state transitions reject backwards or terminal rollback", () => {
  assert.equal(canTransitionPaymentStatus("RELEASED", "HELD"), false);
  assert.equal(canTransitionPaymentStatus("RELEASED", "AUTHORIZED"), false);
  assert.equal(canTransitionPaymentStatus("REFUNDED", "HELD"), false);
  assert.equal(canTransitionPaymentStatus("FAILED", "HELD"), false);
  assert.equal(canTransitionPaymentStatus("RELEASED", "REFUNDED"), true);
  assert.equal(canTransitionPaymentStatus("FAILED", "FAILED"), true);
});
