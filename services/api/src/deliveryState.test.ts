import { describe, expect, it } from "node:test";
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
    for (const [from, to] of lifecycle) expect(canTransition(from, to)).toBe(true);
  });

  it("rejects skipped and backwards transitions", () => {
    expect(canTransition("PAYMENT_AUTHORIZED", "PICKED_UP")).toBe(false);
    expect(canTransition("DELIVERED", "IN_TRANSIT")).toBe(false);
    expect(() => assertTransition("CANCELLED", "DRIVER_ASSIGNED")).toThrow();
  });
});
