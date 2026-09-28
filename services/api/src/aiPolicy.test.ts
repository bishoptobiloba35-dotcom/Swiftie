import test from "node:test";
import assert from "node:assert/strict";
import { canCreatePersonalBuyOrder, canDispatchBusiness, canManageBusiness, canUseAiAction } from "./aiPolicy.js";

test("SwiftDrop AI policy: action capability is Premium-only", () => {
  assert.equal(canUseAiAction("BASIC"), false);
  assert.equal(canUseAiAction("PREMIUM"), true);
});

test("SwiftDrop AI policy: personal Buy & Deliver is customer-only", () => {
  assert.equal(canCreatePersonalBuyOrder("CUSTOMER"), true);
  assert.equal(canCreatePersonalBuyOrder("AGENT"), false);
  assert.equal(canCreatePersonalBuyOrder("DRIVER"), false);
  assert.equal(canCreatePersonalBuyOrder("ADMIN"), false);
});

test("SwiftDrop AI policy: business management and dispatch roles are restricted", () => {
  assert.equal(canManageBusiness("CUSTOMER"), true);
  assert.equal(canManageBusiness("ADMIN"), true);
  assert.equal(canManageBusiness("AGENT"), false);
  assert.equal(canDispatchBusiness("OWNER"), true);
  assert.equal(canDispatchBusiness("ADMIN"), true);
  assert.equal(canDispatchBusiness("DISPATCHER"), true);
  assert.equal(canDispatchBusiness("VIEWER"), false);
});
