ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS checkout_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_buyer_checkout_key
  ON marketplace_orders(buyer_user_id, checkout_idempotency_key)
  WHERE checkout_idempotency_key IS NOT NULL;
