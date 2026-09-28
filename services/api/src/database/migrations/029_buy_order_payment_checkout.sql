-- Buy & Deliver checkout metadata needed for resumable Paystack checkout.
ALTER TABLE buy_order_payments
  ADD COLUMN IF NOT EXISTS authorization_url TEXT,
  ADD COLUMN IF NOT EXISTS access_code TEXT;
CREATE INDEX IF NOT EXISTS idx_buy_order_payments_provider_reference
  ON buy_order_payments(provider_reference);
