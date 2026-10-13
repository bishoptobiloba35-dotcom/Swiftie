import test from "node:test";
import assert from "node:assert/strict";
import { calculatePayoutFeeMinor, payoutAccountNameMatches } from "./driverPayoutLogic.js";

test("standard payout fee is zero", () => {
  assert.equal(calculatePayoutFeeMinor(100_000, "standard"), 0);
});

test("instant payout fee uses 1 percent with the 5000 minor floor", () => {
  assert.equal(calculatePayoutFeeMinor(1_000_000, "instant"), 10_000);
  assert.equal(calculatePayoutFeeMinor(100_000, "instant"), 5_000);
});

test("instant payout fee uses the 50000 minor ceiling", () => {
  assert.equal(calculatePayoutFeeMinor(100_000_000, "instant"), 50_000);
});

test("invalid payout amounts are rejected", () => {
  assert.throws(() => calculatePayoutFeeMinor(0, "standard"));
  assert.throws(() => calculatePayoutFeeMinor(1.5, "instant"));
});

test("account-name matching ignores honorifics and middle names but checks first and last", () => {
  assert.equal(payoutAccountNameMatches("Dr. Adaeze Ngozi Okafor", "ADAEZE OKAFOR"), true);
  assert.equal(payoutAccountNameMatches("Adaeze Okafor", "Mr Adaeze Chukwu Okafor"), true);
  assert.equal(payoutAccountNameMatches("Adaeze Okafor", "Adaeze Eze"), false);
  assert.equal(payoutAccountNameMatches("Adaeze", "Adaeze"), false);
});

import { isDuplicatePaystackReferenceError, shouldReuseInFlightPayout } from "./driverPayoutLogic.js";

test("a timed-out payout with a reserved reference is reused rather than posting a second transfer", () => {
  assert.equal(shouldReuseInFlightPayout("PROCESSING", "payout-driver-123"), true);
  assert.equal(shouldReuseInFlightPayout("PROCESSING", null), false);
  assert.equal(shouldReuseInFlightPayout("FAILED", "payout-driver-123"), false);
  assert.equal(shouldReuseInFlightPayout("ELIGIBLE", "payout-driver-123"), false);
});

test("duplicate-reference responses trigger verification of the existing reference", () => {
  assert.equal(isDuplicatePaystackReferenceError("Duplicate reference"), true);
  assert.equal(isDuplicatePaystackReferenceError("reference already exists"), true);
  assert.equal(isDuplicatePaystackReferenceError("insufficient balance"), false);
});
