import { pool } from "./database/db.js";

export type PricingConfig = {
  version: number;
  fuelPriceMinorPerLitre: number;
  fuelSource: string;
  serviceChargeBps: number;
  protectionReserveBps: number;
  perishableSurchargeBps: number;
  roleChargeBps: number;
  effectiveAt: string;
};

function envFuelPrice(): number {
  const value = Number(process.env.SWIFTDROP_FUEL_PRICE_MINOR_PER_LITRE ?? "");
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SWIFTDROP_FUEL_PRICE_MINOR_PER_LITRE must be configured as a positive NGN minor-unit value");
  }
  return value;
}

function row(value: any): PricingConfig {
  return {
    version: Number(value.version),
    fuelPriceMinorPerLitre: Number(value.fuel_price_minor_per_litre),
    fuelSource: String(value.fuel_source),
    serviceChargeBps: Number(value.service_charge_bps),
    protectionReserveBps: Number(value.protection_reserve_bps),
    perishableSurchargeBps: Number(value.perishable_surcharge_bps),
    roleChargeBps: Number(value.role_charge_bps),
    effectiveAt: new Date(value.effective_at).toISOString()
  };
}

export async function getActivePricingConfig(): Promise<PricingConfig> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `SELECT version, fuel_price_minor_per_litre, fuel_source, service_charge_bps,
            protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at
       FROM pricing_configs
      WHERE effective_at <= now()
      ORDER BY effective_at DESC, version DESC
      LIMIT 1`
  );
  if (result.rows[0]) return row(result.rows[0]);

  const fuel = envFuelPrice();
  const source = String(process.env.SWIFTDROP_FUEL_PRICE_SOURCE ?? "operator-configured");
  const values = [
    fuel, source,
    Number(process.env.SWIFTDROP_SERVICE_CHARGE_BPS ?? 500),
    Number(process.env.SWIFTDROP_PROTECTION_RESERVE_BPS ?? 1000),
    Number(process.env.SWIFTDROP_PERISHABLE_SURCHARGE_BPS ?? 1500),
    Number(process.env.SWIFTDROP_ROLE_CHARGE_BPS ?? 1000)
  ];
  const inserted = await pool.query(
    `INSERT INTO pricing_configs
      (version, fuel_price_minor_per_litre, fuel_source, service_charge_bps, protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at)
     VALUES (COALESCE((SELECT MAX(version) + 1 FROM pricing_configs),1),$1,$2,$3,$4,$5,$6,now())
     RETURNING version, fuel_price_minor_per_litre, fuel_source, service_charge_bps, protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at`,
    values
  );
  return row(inserted.rows[0]);
}

export async function createPricingConfig(input: {
  fuelPriceMinorPerLitre: number;
  fuelSource: string;
  serviceChargeBps?: number;
  protectionReserveBps?: number;
  perishableSurchargeBps?: number;
  roleChargeBps?: number;
}): Promise<PricingConfig> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO pricing_configs
      (version, fuel_price_minor_per_litre, fuel_source, service_charge_bps, protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at)
     VALUES (COALESCE((SELECT MAX(version) + 1 FROM pricing_configs),1),$1,$2,$3,$4,$5,$6,now())
     RETURNING version, fuel_price_minor_per_litre, fuel_source, service_charge_bps, protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at`,
    [
      input.fuelPriceMinorPerLitre, input.fuelSource.trim(),
      input.serviceChargeBps ?? 500, input.protectionReserveBps ?? 1000,
      input.perishableSurchargeBps ?? 1500, input.roleChargeBps ?? 1000
    ]
  );
  return row(result.rows[0]);
}
