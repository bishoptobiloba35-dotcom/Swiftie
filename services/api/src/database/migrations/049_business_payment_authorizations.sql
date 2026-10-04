-- Reusable Paystack authorizations for approved business recurring payments.
CREATE TABLE IF NOT EXISTS business_payment_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('paystack')),
  authorization_code TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','FAILED')),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(business_id, user_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_business_payment_authorizations_business
  ON business_payment_authorizations(business_id, status, updated_at DESC);
