-- Version and preserve pricing on existing deliveries before defaulting new orders.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pricing_version TEXT,
  ADD COLUMN IF NOT EXISTS quote_fuel_surcharge_minor BIGINT NOT NULL DEFAULT 0;

UPDATE deliveries
   SET pricing_version = CASE
     WHEN quote_pricing_version IS NOT NULL THEN 'legacy-config-v' || quote_pricing_version::TEXT
     ELSE 'legacy'
   END
 WHERE pricing_version IS NULL;

ALTER TABLE deliveries ALTER COLUMN pricing_version SET DEFAULT 'v2';

COMMENT ON COLUMN deliveries.pricing_version IS
  'Rate-card version applied to this delivery. Legacy deliveries retain their historical version label.';
COMMENT ON COLUMN deliveries.quote_fuel_surcharge_minor IS
  'Flat fuel surcharge in NGN minor units (kobo), distinct from the fuel reference price.';

-- Apply v2 percentages using the latest operator-configured fuel reference.
INSERT INTO pricing_configs (
  version, fuel_price_minor_per_litre, fuel_source, service_charge_bps,
  protection_reserve_bps, perishable_surcharge_bps, role_charge_bps, effective_at
)
SELECT
  COALESCE((SELECT MAX(version) FROM pricing_configs), 0) + 1,
  COALESCE((SELECT fuel_price_minor_per_litre FROM pricing_configs ORDER BY effective_at DESC, version DESC LIMIT 1), 250000),
  'pricing-v2-defaults', 1000, 500, 1500, 1000, now()
WHERE NOT EXISTS (SELECT 1 FROM pricing_configs WHERE fuel_source = 'pricing-v2-defaults');
