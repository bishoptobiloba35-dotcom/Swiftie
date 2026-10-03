-- Persist Paystack checkout session data so payment initialization can be resumed
-- without creating a second transaction for the same delivery.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS authorization_url TEXT,
  ADD COLUMN IF NOT EXISTS access_code TEXT;
