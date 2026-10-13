import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_FARE_MINOR, DISTANCE_RATE_MINOR, SERVICE_CHARGE_BPS, COURIER_SHARE_BPS,
  PROTECTION_RESERVE_BPS, MINIMUM_ORDER_MINOR, EXPRESS_SURCHARGE_BPS,
  FUEL_SURCHARGE_MINOR, FUEL_SURCHARGE_PLATFORM_BPS, INSTANT_PAYOUT_FEE_BPS,
  INSTANT_PAYOUT_FEE_MIN_MINOR, INSTANT_PAYOUT_FEE_MAX_MINOR, STORAGE_FEE_SMALL_MINOR,
  STORAGE_FEE_MEDIUM_MINOR, STORAGE_FEE_LARGE_MINOR, STORAGE_GRACE_HOURS, STORAGE_MAX_HOURS,
  calculateFare, assertMinimumOrder, expressSurchargeMinor, courierShareFromFeeMinor
} from "./pricingConstants.js";

test("v2 rate card constants match the approved values in kobo", () => {
  assert.deepEqual([BASE_FARE_MINOR,DISTANCE_RATE_MINOR,SERVICE_CHARGE_BPS,COURIER_SHARE_BPS,PROTECTION_RESERVE_BPS,MINIMUM_ORDER_MINOR,EXPRESS_SURCHARGE_BPS,FUEL_SURCHARGE_MINOR,FUEL_SURCHARGE_PLATFORM_BPS],[60000,15000,1000,7200,500,80000,2500,15000,1000]);
  assert.deepEqual([INSTANT_PAYOUT_FEE_BPS,INSTANT_PAYOUT_FEE_MIN_MINOR,INSTANT_PAYOUT_FEE_MAX_MINOR,STORAGE_FEE_SMALL_MINOR,STORAGE_FEE_MEDIUM_MINOR,STORAGE_FEE_LARGE_MINOR,STORAGE_GRACE_HOURS,STORAGE_MAX_HOURS],[100,5000,50000,30000,50000,80000,48,168]);
});
test("calculateFare uses kobo and returns the expected five-kilometre fare", () => {
  assert.deepEqual(calculateFare(5), {baseFare:60000,distanceFee:75000,fuelSurcharge:15000,serviceCharge:13500,total:163500,pricingVersion:"v2"});
});
test("minimum-order guard rejects below ₦800 and accepts the minimum", () => {
  assert.throws(() => assertMinimumOrder(79999), /below the minimum/);
  assert.doesNotThrow(() => assertMinimumOrder(80000));
});
test("express surcharge is 25 percent and courier share is 72 percent", () => {
  assert.equal(expressSurchargeMinor(100000),25000);
  assert.equal(courierShareFromFeeMinor(100000),72000);
});
test("fare calculator rejects invalid distance and fee helpers reject invalid values", () => {
  assert.throws(() => calculateFare(-1));
  assert.throws(() => calculateFare(Number.NaN));
  assert.throws(() => expressSurchargeMinor(-1));
  assert.throws(() => courierShareFromFeeMinor(1.5));
});
