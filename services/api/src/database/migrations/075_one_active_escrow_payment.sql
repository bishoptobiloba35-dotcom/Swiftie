-- Prevent duplicate concurrent escrow charges for the same order.
-- Failed/abandoned attempts remain retryable; only one pending attempt may exist.
CREATE UNIQUE INDEX IF NOT EXISTS escrow_payment_attempts_one_pending_per_order
  ON escrow_payment_attempts(order_id)
  WHERE status='PENDING';
