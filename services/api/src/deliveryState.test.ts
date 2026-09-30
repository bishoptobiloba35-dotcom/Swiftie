import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition } from "./deliveryState.js";

describe("delivery state machine", () => {
  it("allows the normal delivery lifecycle", () => {
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

  it("rejects skipped and backwards transitions", () => {
    assert.equal(canTransition("PAYMENT_AUTHORIZED", "PICKED_UP"), false);
    assert.equal(canTransition("DELIVERED", "IN_TRANSIT"), false);
    assert.throws(() => assertTransition("CANCELLED", "DRIVER_ASSIGNED"));
    assert.equal(canTransition("RETURNED", "DELIVERED"), false);
    assert.equal(canTransition("RETURNED", "IN_TRANSIT"), false);
  });
});
