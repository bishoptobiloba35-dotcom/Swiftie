-- Versioned server-side pricing configuration.
CREATE TABLE IF NOT EXISTS pricing_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL UNIQUE,
  fuel_price_minor_per_litre BIGINT NOT NULL CHECK (fuel_price_minor_per_litre > 0),
  fuel_source TEXT NOT NULL CHECK (length(trim(fuel_source)) >= 3),
  service_charge_bps INTEGER NOT NULL DEFAULT 500 CHECK (service_charge_bps >= 0 AND service_charge_bps <= 5000),
  protection_reserve_bps INTEGER NOT NULL DEFAULT 1000 CHECK (protection_reserve_bps >= 0 AND protection_reserve_bps <= 5000),
  perishable_surcharge_bps INTEGER NOT NULL DEFAULT 1500 CHECK (perishable_surcharge_bps >= 0 AND perishable_surcharge_bps <= 5000),
  role_charge_bps INTEGER NOT NULL DEFAULT 1000 CHECK (role_charge_bps >= 0 AND role_charge_bps <= 5000),
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_configs_effective
  ON pricing_configs(effective_at DESC, version DESC);

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS quote_fuel_reference_minor BIGINT,
  ADD COLUMN IF NOT EXISTS quote_protection_reserve_minor BIGINT,
  ADD COLUMN IF NOT EXISTS quote_pricing_version INTEGER;
