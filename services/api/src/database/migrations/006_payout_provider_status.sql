ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payouts_provider_reference
  ON payouts(provider_reference)
  WHERE provider_reference IS NOT NULL;
