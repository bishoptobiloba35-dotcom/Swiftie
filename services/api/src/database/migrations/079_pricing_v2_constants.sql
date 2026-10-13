-- Pricing v2 rate card: version stamp on deliveries for historical quotes.
-- Backfill legacy versions before setting the v2 default for new orders.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pricing_version TEXT;

UPDATE deliveries
   SET pricing_version = CASE
     WHEN quote_pricing_version IS NOT NULL
       THEN 'legacy-config-v' || quote_pricing_version::TEXT
     ELSE 'legacy'
   END
 WHERE pricing_version IS NULL;

ALTER TABLE deliveries
  ALTER COLUMN pricing_version SET DEFAULT 'v2';

COMMENT ON COLUMN deliveries.pricing_version IS
  'Rate-card version used when the order quote was created. New orders default to v2; existing orders retain a legacy/config version.';

-- Seed the v2 percentage defaults only if this seed has not already been applied.
-- Preserve the currently configured fuel reference rather than replacing it with a hard-coded price.
INSERT INTO pricing_configs (
  version,
  fuel_price_minor_per_litre,
  fuel_source,
  service_charge_bps,
  protection_reserve_bps,
  perishable_surcharge_bps,
  role_charge_bps,
  effective_at
)
SELECT
  COALESCE((SELECT MAX(version) FROM pricing_configs), 0) + 1,
  COALESCE(
    (SELECT fuel_price_minor_per_litre FROM pricing_configs ORDER BY effective_at DESC, version DESC LIMIT 1),
    250000
  ),
  'pricing-v2-defaults',
  1000,
  500,
  1500,
  1000,
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_configs WHERE fuel_source = 'pricing-v2-defaults'
);
