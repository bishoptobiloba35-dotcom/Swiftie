-- Marketplace payment ledger. Kept separate from delivery payments because marketplace orders have their own lifecycle.
CREATE TABLE IF NOT EXISTS marketplace_order_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_order_id UUID NOT NULL UNIQUE REFERENCES marketplace_orders(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'paystack' CHECK (provider IN ('paystack')),
  provider_reference TEXT UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','AUTHORIZED','FAILED','REFUNDED')),
  provider_status TEXT,
  authorization_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_payments_status
  ON marketplace_order_payments(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_payments_buyer
  ON marketplace_order_payments(buyer_user_id, created_at DESC);
