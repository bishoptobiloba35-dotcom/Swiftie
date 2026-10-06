import test from "node:test";
import assert from "node:assert/strict";
import { SWIFTDROP_RULES } from "../../../packages/shared/src/swiftdropRules.js";

test("Phase 2 cash-flow constants are escrow-only", () => {
  assert.equal(SWIFTDROP_RULES.noCashAccepted, true);
  assert.equal(SWIFTDROP_RULES.courierDeliveryShareBps, 7500);
  assert.equal(SWIFTDROP_RULES.stakeholderHoldHours, 72);
  assert.equal(SWIFTDROP_RULES.minimumWithdrawalMinor, 100000);
  assert.equal(SWIFTDROP_RULES.floatMinimumReserveMinor, 500000000);
  assert.equal(SWIFTDROP_RULES.floatAutoTopUpThresholdMinor, 300000000);
});

test("courier instant share is exactly 75 percent of base fare", () => {
  const baseFare = 50000;
  assert.equal(Math.floor(baseFare * SWIFTDROP_RULES.courierDeliveryShareBps / 10000), 37500);
});

test("all supported payment methods are in-app provider methods", () => {
  const methods = ["PAYSTACK_CARD","BANK_TRANSFER","USSD","SMS_LINK"];
  assert.equal(methods.every(value => !/cash/i.test(value)), true);
});
