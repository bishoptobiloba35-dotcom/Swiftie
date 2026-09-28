-- Expand Buy & Deliver payment state machine for post-delivery settlement.
ALTER TABLE buy_orders
  DROP CONSTRAINT IF EXISTS buy_orders_payment_status_check;
ALTER TABLE buy_orders
  ADD CONSTRAINT buy_orders_payment_status_check
  CHECK (payment_status IN ('PENDING','AUTHORIZED','HELD','RELEASED','REFUNDED','FAILED'));

CREATE INDEX IF NOT EXISTS idx_buy_orders_delivery_payment
  ON buy_orders(delivery_id, payment_status, status);
