import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  BASE_FARE_MINOR,
  DISTANCE_RATE_MINOR,
  SERVICE_CHARGE_BPS,
  COURIER_SHARE_BPS,
  PROTECTION_RESERVE_BPS,
  MINIMUM_ORDER_MINOR,
  EXPRESS_SURCHARGE_BPS,
  FUEL_SURCHARGE_MINOR,
  FUEL_SURCHARGE_PLATFORM_BPS,
  INSTANT_PAYOUT_FEE_BPS,
  INSTANT_PAYOUT_FEE_MIN_MINOR,
  INSTANT_PAYOUT_FEE_MAX_MINOR,
  STORAGE_FEE_SMALL_MINOR,
  STORAGE_FEE_MEDIUM_MINOR,
  STORAGE_FEE_LARGE_MINOR,
  STORAGE_GRACE_HOURS,
  STORAGE_MAX_HOURS,
  PRICING_VERSION,
  calculateFare,
  assertMinimumOrder,
  expressSurchargeMinor,
  courierShareFromFeeMinor
} from "./pricingConstants.js";

test("v2 constants match the approved rate card", () => {
  assert.equal(BASE_FARE_MINOR, 60_000);
  assert.equal(DISTANCE_RATE_MINOR, 15_000);
  assert.equal(SERVICE_CHARGE_BPS, 1_000);
  assert.equal(COURIER_SHARE_BPS, 7_200);
  assert.equal(PROTECTION_RESERVE_BPS, 500);
  assert.equal(MINIMUM_ORDER_MINOR, 80_000);
  assert.equal(EXPRESS_SURCHARGE_BPS, 2_500);
  assert.equal(FUEL_SURCHARGE_MINOR, 15_000);
  assert.equal(FUEL_SURCHARGE_PLATFORM_BPS, 1_000);
  assert.equal(INSTANT_PAYOUT_FEE_BPS, 100);
  assert.equal(INSTANT_PAYOUT_FEE_MIN_MINOR, 5_000);
  assert.equal(INSTANT_PAYOUT_FEE_MAX_MINOR, 50_000);
  assert.equal(STORAGE_FEE_SMALL_MINOR, 30_000);
  assert.equal(STORAGE_FEE_MEDIUM_MINOR, 50_000);
  assert.equal(STORAGE_FEE_LARGE_MINOR, 80_000);
  assert.equal(STORAGE_GRACE_HOURS, 48);
  assert.equal(STORAGE_MAX_HOURS, 168);
  assert.equal(PRICING_VERSION, "v2");
});

test("calculateFare(5) returns the v2 breakdown in kobo (minor units)", () => {
  // 5 km × ₦150 = ₦750 → 75_000 kobo
  // base ₦600 → 60_000; fuel ₦150 → 15_000
  // service 10% of (base + distance) = 13_500
  // total = 60_000 + 75_000 + 15_000 + 13_500 = 163_500
  const fare = calculateFare(5);
  assert.equal(fare.baseFare, 60_000);
  assert.equal(fare.distanceFee, 75_000);
  assert.equal(fare.fuelSurcharge, 15_000);
  assert.equal(fare.serviceCharge, 13_500);
  assert.equal(fare.total, 163_500);
  assert.equal(fare.pricingVersion, "v2");
});

test("order below MINIMUM_ORDER_MINOR is rejected", () => {
  assert.throws(() => assertMinimumOrder(MINIMUM_ORDER_MINOR - 1));
  assert.throws(() => assertMinimumOrder(0));
  assert.doesNotThrow(() => assertMinimumOrder(MINIMUM_ORDER_MINOR));
  assert.doesNotThrow(() => assertMinimumOrder(163_500));
});

test("express surcharge is 25%", () => {
  assert.equal(EXPRESS_SURCHARGE_BPS, 2_500);
  const deliveryFee = 100_000;
  assert.equal(expressSurchargeMinor(deliveryFee), 25_000);
});

test("courier share is 72% of delivery fee", () => {
  assert.equal(COURIER_SHARE_BPS, 7_200);
  const deliveryFee = 100_000;
  assert.equal(courierShareFromFeeMinor(deliveryFee), 72_000);
  const fare = calculateFare(5);
  const deliveryComponent = fare.baseFare + fare.distanceFee + fare.fuelSurcharge;
  assert.equal(courierShareFromFeeMinor(deliveryComponent), Math.floor(deliveryComponent * 7_200 / 10_000));
});

test("historical pricing_version stamp is v2 for new quotes", () => {
  assert.equal(calculateFare(1).pricingVersion, "v2");
  assert.equal(PRICING_VERSION, "v2");
});

test("legacy basis-point representations remain consistent", () => {
  assert.equal(SERVICE_CHARGE_BPS / 10_000, 0.10);
  assert.equal(PROTECTION_RESERVE_BPS / 10_000, 0.05);
  assert.equal(COURIER_SHARE_BPS / 10_000, 0.72);
});

test("pricing migration backfills existing orders before defaulting new orders to v2", async () => {
  const migration = await readFile(
    new URL("./database/migrations/079_pricing_v2_constants.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS pricing_version TEXT/);
  assert.match(migration, /WHEN quote_pricing_version IS NOT NULL/);
  assert.match(migration, /THEN 'legacy-config-v' \|\| quote_pricing_version::TEXT/);
  assert.match(migration, /ELSE 'legacy'/);
  assert.match(migration, /ALTER COLUMN pricing_version SET DEFAULT 'v2'/);
});
