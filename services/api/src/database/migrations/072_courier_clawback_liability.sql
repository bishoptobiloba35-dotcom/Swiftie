CREATE TABLE IF NOT EXISTS escrow_courier_clawback_liabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  courier_user_id UUID NOT NULL REFERENCES users(id),
  clawback_id UUID NOT NULL UNIQUE REFERENCES escrow_courier_clawbacks(id),
  original_amount_minor BIGINT NOT NULL CHECK (original_amount_minor > 0),
  outstanding_amount_minor BIGINT NOT NULL CHECK (outstanding_amount_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('OUTSTANDING','RECOVERED','CANCELLED')),
  recovered_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (recovered_amount_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recovered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_escrow_clawback_liabilities_courier_status
  ON escrow_courier_clawback_liabilities(courier_user_id,status,created_at);