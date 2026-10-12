/**
 * SwiftDrop pricing constants (v2).
 * All *_MINOR values are NGN kobo (1 NGN = 100 kobo).
 * Storage / instant-payout fee constants are declared here for later wiring —
 * do not apply them in quote logic until product enables those features.
 */

export const PRICING_VERSION = "v2" as const;

/** Base pickup/dispatch fee — ₦600 */
export const BASE_FARE_MINOR = 60_000;

/** Per-kilometre distance rate — ₦150/km */
export const DISTANCE_RATE_MINOR = 15_000;

/** Platform service charge — 10% */
export const SERVICE_CHARGE_BPS = 1_000;

/** Courier share of delivery fee — 72% */
export const COURIER_SHARE_BPS = 7_200;

/** Protection reserve on declared value — 5% */
export const PROTECTION_RESERVE_BPS = 500;

/** Minimum payable order total — ₦800 */
export const MINIMUM_ORDER_MINOR = 80_000;

/** Express delivery surcharge — 25% */
export const EXPRESS_SURCHARGE_BPS = 2_500;

/** Flat fuel surcharge — ₦150 */
export const FUEL_SURCHARGE_MINOR = 15_000;

/** Platform cut of fuel surcharge — 10% */
export const FUEL_SURCHARGE_PLATFORM_BPS = 1_000;

/** Instant payout fee — 1% (not wired yet) */
export const INSTANT_PAYOUT_FEE_BPS = 100;

/** Instant payout fee floor — ₦50 (not wired yet) */
export const INSTANT_PAYOUT_FEE_MIN_MINOR = 5_000;

/** Instant payout fee ceiling — ₦500 (not wired yet) */
export const INSTANT_PAYOUT_FEE_MAX_MINOR = 50_000;

/** Storage fee small parcel / day — ₦300 (not wired yet) */
export const STORAGE_FEE_SMALL_MINOR = 30_000;

/** Storage fee medium parcel / day — ₦500 (not wired yet) */
export const STORAGE_FEE_MEDIUM_MINOR = 50_000;

/** Storage fee large parcel / day — ₦800 (not wired yet) */
export const STORAGE_FEE_LARGE_MINOR = 80_000;

/** Free storage window after arrival — 48 hours (not wired yet) */
export const STORAGE_GRACE_HOURS = 48;

/** Maximum storage window — 168 hours / 7 days (not wired yet) */
export const STORAGE_MAX_HOURS = 168;

export type FareBreakdown = {
  baseFare: number;
  distanceFee: number;
  fuelSurcharge: number;
  serviceCharge: number;
  total: number;
  pricingVersion: typeof PRICING_VERSION;
};

/**
 * Pure fare calculator for the v2 rate card.
 * Service charge is applied to (base + distance) only — not to the fuel surcharge.
 */
export function calculateFare(distanceKm: number): FareBreakdown {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new Error("distanceKm must be a non-negative number");
  }
  const baseFare = BASE_FARE_MINOR;
  const distanceFee = Math.ceil(distanceKm * DISTANCE_RATE_MINOR);
  const fuelSurcharge = FUEL_SURCHARGE_MINOR;
  const serviceCharge = Math.ceil((baseFare + distanceFee) * SERVICE_CHARGE_BPS / 10_000);
  const total = baseFare + distanceFee + fuelSurcharge + serviceCharge;
  return {
    baseFare,
    distanceFee,
    fuelSurcharge,
    serviceCharge,
    total,
    pricingVersion: PRICING_VERSION
  };
}

/** Throws when total is below the configured minimum order amount. */
export function assertMinimumOrder(totalMinor: number): void {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < MINIMUM_ORDER_MINOR) {
    throw new Error(
      `Order total ${totalMinor} is below the minimum of ${MINIMUM_ORDER_MINOR} kobo`
    );
  }
}

/** Express surcharge (25% of the provided delivery fee base). */
export function expressSurchargeMinor(deliveryFeeMinor: number): number {
  return Math.ceil(deliveryFeeMinor * EXPRESS_SURCHARGE_BPS / 10_000);
}

/** Courier share (72% of the delivery fee). */
export function courierShareFromFeeMinor(deliveryFeeMinor: number): number {
  return Math.floor(deliveryFeeMinor * COURIER_SHARE_BPS / 10_000);
}
