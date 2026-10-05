-- Idempotent Paystack refund ledger for unavailable errand items.
CREATE TABLE IF NOT EXISTS buy_order_item_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id UUID NOT NULL REFERENCES buy_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL UNIQUE REFERENCES buy_order_items(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES buy_order_payments(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','PENDING','PROCESSING','PROCESSED','FAILED','NEEDS_ATTENTION','RECONCILIATION_REQUIRED')),
  provider_ref TEXT UNIQUE,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_order_item_refunds_order_status
  ON buy_order_item_refunds(buy_order_id, status, created_at);

COMMENT ON TABLE buy_order_item_refunds IS
  'Idempotent per-item refund intent and Paystack refund lifecycle for unified errand unavailable items.';