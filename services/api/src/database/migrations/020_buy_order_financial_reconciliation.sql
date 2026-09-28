ALTER TABLE buy_orders ADD COLUMN IF NOT EXISTS unused_authorization_minor BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS refunded_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE buy_order_payments ADD COLUMN IF NOT EXISTS refund_reference TEXT, ADD COLUMN IF NOT EXISTS refund_status TEXT, ADD COLUMN IF NOT EXISTS refund_amount_minor BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS total_refunded_minor BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_buy_order_payments_refund_reference ON buy_order_payments(refund_reference) WHERE refund_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_buy_order_payments_refund_status ON buy_order_payments(refund_status);
CREATE INDEX IF NOT EXISTS idx_buy_orders_payment_reference ON buy_orders(payment_reference);
