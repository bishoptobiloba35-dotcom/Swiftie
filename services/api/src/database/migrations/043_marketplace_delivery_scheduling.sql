ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS requested_delivery_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_requested_delivery
  ON marketplace_orders(requested_delivery_at)
  WHERE requested_delivery_at IS NOT NULL;