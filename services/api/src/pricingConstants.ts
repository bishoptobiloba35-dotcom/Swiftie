/**
 * SwiftDrop pricing v2. All *_MINOR values are NGN kobo.
 * Storage and instant-payout fees are declared only; they are intentionally not charged yet.
 */
export const PRICING_VERSION = "v2" as const;
export const BASE_FARE_MINOR = 60_000;
export const DISTANCE_RATE_MINOR = 15_000;
export const SERVICE_CHARGE_BPS = 1_000;
export const COURIER_SHARE_BPS = 7_200;
export const PROTECTION_RESERVE_BPS = 500;
export const MINIMUM_ORDER_MINOR = 80_000;
export const EXPRESS_SURCHARGE_BPS = 2_500;
export const FUEL_SURCHARGE_MINOR = 15_000;
export const FUEL_SURCHARGE_PLATFORM_BPS = 1_000;
export const INSTANT_PAYOUT_FEE_BPS = 100;
export const INSTANT_PAYOUT_FEE_MIN_MINOR = 5_000;
export const INSTANT_PAYOUT_FEE_MAX_MINOR = 50_000;
export const STORAGE_FEE_SMALL_MINOR = 30_000;
export const STORAGE_FEE_MEDIUM_MINOR = 50_000;
export const STORAGE_FEE_LARGE_MINOR = 80_000;
export const STORAGE_GRACE_HOURS = 48;
export const STORAGE_MAX_HOURS = 168;

export type FareBreakdown = {
  baseFare: number;
  distanceFee: number;
  fuelSurcharge: number;
  serviceCharge: number;
  total: number;
  pricingVersion: typeof PRICING_VERSION;
};

/** Service charge is applied to base + distance, not to the fuel surcharge. */
export function calculateFare(distanceKm: number): FareBreakdown {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error("distanceKm must be a non-negative number");
  const baseFare = BASE_FARE_MINOR;
  const distanceFee = Math.ceil(distanceKm * DISTANCE_RATE_MINOR);
  const fuelSurcharge = FUEL_SURCHARGE_MINOR;
  const serviceCharge = Math.ceil((baseFare + distanceFee) * SERVICE_CHARGE_BPS / 10_000);
  return { baseFare, distanceFee, fuelSurcharge, serviceCharge, total: baseFare + distanceFee + fuelSurcharge + serviceCharge, pricingVersion: PRICING_VERSION };
}

export function assertMinimumOrder(totalMinor: number): void {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < MINIMUM_ORDER_MINOR) {
    throw new Error(`Order total ${totalMinor} is below the minimum of ${MINIMUM_ORDER_MINOR} kobo`);
  }
}
export function expressSurchargeMinor(deliveryFeeMinor: number): number {
  if (!Number.isSafeInteger(deliveryFeeMinor) || deliveryFeeMinor < 0) throw new Error("deliveryFeeMinor must be a non-negative integer");
  return Math.ceil(deliveryFeeMinor * EXPRESS_SURCHARGE_BPS / 10_000);
}
export function courierShareFromFeeMinor(deliveryFeeMinor: number): number {
  if (!Number.isSafeInteger(deliveryFeeMinor) || deliveryFeeMinor < 0) throw new Error("deliveryFeeMinor must be a non-negative integer");
  return Math.floor(deliveryFeeMinor * COURIER_SHARE_BPS / 10_000);
}
