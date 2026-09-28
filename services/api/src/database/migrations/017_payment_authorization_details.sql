ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS authorization_url TEXT,
  ADD COLUMN IF NOT EXISTS access_code TEXT;
