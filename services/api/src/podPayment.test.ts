import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { podAllowsHandover } from "./podPayment.js";
import {
  canTransition,
  assertTransition,
  isAwaitingReceiverPayment,
  isPaymentVerified
} from "./deliveryState.js";

describe("digital POD guards", () => {
  it("blocks handover for PAY_ON_DELIVERY until verified", () => {
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "RECEIVER_PAYMENT_PENDING", null), false);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "ARRIVED", null), false);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "IN_TRANSIT", null), false);
  });

  it("allows handover after verification", () => {
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "PAYMENT_VERIFIED", "2026-01-01T00:00:00Z"), true);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "HANDED_OVER", "2026-01-01T00:00:00Z"), true);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "PIN_CONFIRMED", "2026-01-01T00:00:00Z"), true);
    assert.equal(podAllowsHandover("PAY_ON_DELIVERY", "DELIVERED", "2026-01-01T00:00:00Z"), true);
  });

  it("does not block non-POD modes", () => {
    assert.equal(podAllowsHandover("SENDER_ESCROW", "ARRIVED", null), true);
    assert.equal(podAllowsHandover("RECEIVER_ESCROW", "ARRIVED", null), true);
  });

  it("POD state transitions remain legal", () => {
    assert.equal(canTransition("ARRIVED", "RECEIVER_PAYMENT_PENDING"), true);
    assert.equal(canTransition("RECEIVER_PAYMENT_PENDING", "PAYMENT_VERIFIED"), true);
    assert.equal(canTransition("PAYMENT_VERIFIED", "HANDED_OVER"), true);
    assert.equal(canTransition("HANDED_OVER", "PIN_CONFIRMED"), true);
    assert.equal(canTransition("PIN_CONFIRMED", "DELIVERED"), true);
    // Forbidden shortcuts
    assert.equal(canTransition("ARRIVED", "PAYMENT_VERIFIED"), false);
    assert.equal(canTransition("RECEIVER_PAYMENT_PENDING", "HANDED_OVER"), false);
    assert.equal(canTransition("RECEIVER_PAYMENT_PENDING", "DELIVERED"), false);
  });

  it("assertTransition throws on illegal POD skips", () => {
    assert.throws(() => assertTransition("ARRIVED", "PAYMENT_VERIFIED"));
    assert.throws(() => assertTransition("RECEIVER_PAYMENT_PENDING", "PIN_CONFIRMED"));
  });

  it("helpers identify waiting and verified states", () => {
    assert.equal(isAwaitingReceiverPayment("RECEIVER_PAYMENT_PENDING"), true);
    assert.equal(isAwaitingReceiverPayment("PAYMENT_VERIFIED"), false);
    assert.equal(isPaymentVerified("PAYMENT_VERIFIED"), true);
    assert.equal(isPaymentVerified("HANDED_OVER"), true);
    assert.equal(isPaymentVerified("RECEIVER_PAYMENT_PENDING"), false);
  });
});

describe("digital POD full lifecycle path", () => {
  it("walks ARRIVED through RELEASED without illegal jumps", () => {
    const path = [
      "ARRIVED",
      "RECEIVER_PAYMENT_PENDING",
      "PAYMENT_VERIFIED",
      "HANDED_OVER",
      "PIN_CONFIRMED",
      "DELIVERED",
      "DISPUTE_WINDOW",
      "RELEASED"
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assert.equal(
        canTransition(path[i], path[i + 1]),
        true,
        `${path[i]} -> ${path[i + 1]}`
      );
    }
  });
});
