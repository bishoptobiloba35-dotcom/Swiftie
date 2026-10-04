ALTER TABLE business_payment_authorizations
  ADD COLUMN IF NOT EXISTS signature TEXT,
  ADD COLUMN IF NOT EXISTS card_type TEXT,
  ADD COLUMN IF NOT EXISTS card_last4 TEXT,
  ADD COLUMN IF NOT EXISTS card_exp_month TEXT,
  ADD COLUMN IF NOT EXISTS card_exp_year TEXT,
  ADD COLUMN IF NOT EXISTS bank TEXT,
  ADD COLUMN IF NOT EXISTS brand TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_payment_authorizations_signature
  ON business_payment_authorizations(signature)
  WHERE signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_business_payment_authorizations_provider_status
  ON business_payment_authorizations(provider, status, updated_at DESC);
