-- Marketplace payment refund reconciliation.
-- Marketplace item + delivery charges are collected in one Paystack transaction,
-- so dispute refunds must reconcile against marketplace_order_payments rather than
-- the internal delivery-fee allocation payment.
ALTER TABLE marketplace_order_payments
  ADD COLUMN IF NOT EXISTS refund_reference TEXT,
  ADD COLUMN IF NOT EXISTS refund_status TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS total_refunded_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_order_payments_refund_reference
  ON marketplace_order_payments(refund_reference)
  WHERE refund_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketplace_order_payments_refund_status
  ON marketplace_order_payments(refund_status, updated_at DESC);
