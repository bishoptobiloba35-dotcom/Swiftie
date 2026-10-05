-- Competitive operational hardening inspired by Glovo's merchant "Mark as ready" flow.
ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS seller_preparation_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (seller_preparation_minutes >= 0 AND seller_preparation_minutes <= 1440),
  ADD COLUMN IF NOT EXISTS seller_ready_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seller_busy_mode BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE marketplace_orders DROP CONSTRAINT IF EXISTS marketplace_orders_fulfillment_status_check;
ALTER TABLE marketplace_orders ADD CONSTRAINT marketplace_orders_fulfillment_status_check
  CHECK (fulfillment_status IN ('NOT_STARTED','PREPARING','READY','IN_PROGRESS','FULFILLED','CANCELLED'));

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller_ready
  ON marketplace_orders(seller_user_id, fulfillment_status, requested_delivery_at)
  WHERE status IN ('PAID','PROCESSING');

COMMENT ON COLUMN marketplace_orders.seller_preparation_minutes IS 'Seller-estimated preparation time before courier pickup.';
COMMENT ON COLUMN marketplace_orders.seller_ready_at IS 'Timestamp when seller explicitly marks a paid order ready for courier pickup.';
COMMENT ON COLUMN marketplace_orders.seller_busy_mode IS 'Seller can signal temporary operational congestion so preparation estimates remain visible.';
