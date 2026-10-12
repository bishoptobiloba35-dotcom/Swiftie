import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { podAllowsHandover } from "./podPayment.js";
import { canTransition } from "./deliveryState.js";

describe("digital POD guards", () => {
  it("blocks handover for PAY_ON_DELIVERY until verified", () => {
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "RECEIVER_PAYMENT_PENDING", null), false);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "ARRIVED", null), false);
  });

  it("allows handover after verification", () => {
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "PAYMENT_VERIFIED", "2026-01-01T00:00:00Z"), true);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "HANDED_OVER", "2026-01-01T00:00:00Z"), true);
  });

  it("does not block non-POD modes", () => {
    assert.equal(podAllowsHandover("SENDER_ESCROW", "ARRIVED", null), true);
    assert.equal(podAllowsHandover("RECEIVER_ESCROW", "ARRIVED", null), true);
  });

  it("POD state transitions remain legal", () => {
    assert.equal(canTransition("ARRIVED", "RECEIVER_PAYMENT_PENDING"), true);
    assert.equal(canTransition("RECEIVER_PAYMENT_PENDING", "PAYMENT_VERIFIED"), true);
    assert.equal(canTransition("PAYMENT_VERIFIED", "HANDED_OVER"), true);
    assert.equal(canTransition("ARRIVED", "PAYMENT_VERIFIED"), false);
  });
});
