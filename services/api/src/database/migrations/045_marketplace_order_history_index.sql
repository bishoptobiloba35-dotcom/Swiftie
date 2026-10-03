CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer_status_created
  ON marketplace_orders(buyer_user_id, status, created_at DESC);
