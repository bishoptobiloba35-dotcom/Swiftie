import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  isAwaitingReceiverPayment,
  isPaymentVerified
} from "./deliveryState.js";

describe("delivery state machine", () => {
  it("allows the classic SENDER_ESCROW lifecycle", () => {
    const lifecycle = [
      ["CREATED", "PAYMENT_AUTHORIZED"],
      ["PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED"],
      ["DRIVER_ASSIGNED", "DRIVER_AT_PICKUP"],
      ["DRIVER_AT_PICKUP", "PICKED_UP"],
      ["PICKED_UP", "IN_TRANSIT"],
      ["IN_TRANSIT", "ARRIVED"],
      ["ARRIVED", "DELIVERED"]
    ] as const;
    for (const [from, to] of lifecycle) assert.equal(canTransition(from, to), true);
    assert.equal(canTransition("IN_TRANSIT", "RETURNED"), true);
  });

  it("allows the digital PAY_ON_DELIVERY lifecycle", () => {
    const podLifecycle = [
      ["CREATED", "PAYMENT_PENDING"],
      ["PAYMENT_PENDING", "PAYMENT_AUTHORIZED"],
      ["PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED"],
      ["DRIVER_ASSIGNED", "DRIVER_AT_PICKUP"],
      ["DRIVER_AT_PICKUP", "PICKED_UP"],
      ["PICKED_UP", "IN_TRANSIT"],
      ["IN_TRANSIT", "ARRIVED"],
      ["ARRIVED", "RECEIVER_PAYMENT_PENDING"],
      ["RECEIVER_PAYMENT_PENDING", "PAYMENT_VERIFIED"],
      ["PAYMENT_VERIFIED", "HANDED_OVER"],
      ["HANDED_OVER", "PIN_CONFIRMED"],
      ["PIN_CONFIRMED", "DELIVERED"],
      ["DELIVERED", "DISPUTE_WINDOW"],
      ["DISPUTE_WINDOW", "RELEASED"]
    ] as const;
    for (const [from, to] of podLifecycle) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
    }
  });

  it("rejects skipped and backwards transitions", () => {
    assert.equal(canTransition("PAYMENT_AUTHORIZED", "PICKED_UP"), false);
    assert.equal(canTransition("DELIVERED", "IN_TRANSIT"), false);
    assert.throws(() => assertTransition("CANCELLED", "DRIVER_ASSIGNED"));
    assert.equal(canTransition("RETURNED", "DELIVERED"), false);
    assert.equal(canTransition("RETURNED", "IN_TRANSIT"), false);
    // Client must never jump from ARRIVED straight to PAYMENT_VERIFIED
    assert.equal(canTransition("ARRIVED", "PAYMENT_VERIFIED"), false);
    // Webhook-only state cannot be skipped
    assert.equal(canTransition("RECEIVER_PAYMENT_PENDING", "HANDED_OVER"), false);
  });

  it("correctly identifies POD waiting and verified states", () => {
    assert.equal(isAwaitingReceiverPayment("RECEIVER_PAYMENT_PENDING"), true);
    assert.equal(isAwaitingReceiverPayment("ARRIVED"), false);
    assert.equal(isPaymentVerified("PAYMENT_VERIFIED"), true);
    assert.equal(isPaymentVerified("HANDED_OVER"), true);
    assert.equal(isPaymentVerified("RECEIVER_PAYMENT_PENDING"), false);
  });
});
