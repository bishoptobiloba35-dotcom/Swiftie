import { describe, expect, it } from "vitest";
import { canCreatePersonalBuyOrder, canDispatchBusiness, canManageBusiness, canUseAiAction } from "./aiPolicy.js";

describe("SwiftDrop AI policy", () => {
  it("allows informational AI for both plans but action capability only for Premium", () => {
    expect(canUseAiAction("BASIC")).toBe(false);
    expect(canUseAiAction("PREMIUM")).toBe(true);
  });

  it("does not let non-customer roles create personal Buy & Deliver orders", () => {
    expect(canCreatePersonalBuyOrder("CUSTOMER")).toBe(true);
    expect(canCreatePersonalBuyOrder("AGENT")).toBe(false);
    expect(canCreatePersonalBuyOrder("DRIVER")).toBe(false);
    expect(canCreatePersonalBuyOrder("ADMIN")).toBe(false);
  });

  it("restricts business management and dispatch to the intended roles", () => {
    expect(canManageBusiness("CUSTOMER")).toBe(true);
    expect(canManageBusiness("ADMIN")).toBe(true);
    expect(canManageBusiness("AGENT")).toBe(false);
    expect(canDispatchBusiness("OWNER")).toBe(true);
    expect(canDispatchBusiness("ADMIN")).toBe(true);
    expect(canDispatchBusiness("DISPATCHER")).toBe(true);
    expect(canDispatchBusiness("VIEWER")).toBe(false);
  });
});
