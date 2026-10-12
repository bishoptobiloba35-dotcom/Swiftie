-- Pricing v2 rate card: version stamp on deliveries for historical quotes.
-- Existing rows keep NULL/legacy semantics; new orders should set pricing_version='v2'.

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pricing_version TEXT NOT NULL DEFAULT 'v2';

COMMENT ON COLUMN deliveries.pricing_version IS
  'Rate-card version used when the order quote was created (e.g. v1, v2). Historical orders retain their original version after rate changes.';

-- Seed authoritative config row reflecting v2 defaults when none exists yet.
-- Does not overwrite operator-tuned rows already present.
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
  1000,  -- SERVICE_CHARGE_BPS 10%
  500,   -- PROTECTION_RESERVE_BPS 5%
  1500,
  1000,
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_configs WHERE fuel_source = 'pricing-v2-defaults'
);
