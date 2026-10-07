-- Phase 2 settlement ownership and 72-hour stakeholder release scheduling.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS merchant_user_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_deliveries_merchant_user ON deliveries(merchant_user_id);

CREATE TABLE IF NOT EXISTS float_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_date DATE NOT NULL UNIQUE,
  expected_balance_minor BIGINT NOT NULL,
  recorded_balance_minor BIGINT NOT NULL,
  variance_minor BIGINT NOT NULL,
  interest_income_minor BIGINT NOT NULL DEFAULT 0,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_by UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MATCHED','VARIANCE'))
);
