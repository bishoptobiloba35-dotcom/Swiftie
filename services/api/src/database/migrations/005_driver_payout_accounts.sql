ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS payout_bank_code TEXT,
  ADD COLUMN IF NOT EXISTS payout_bank_name TEXT,
  ADD COLUMN IF NOT EXISTS payout_account_number TEXT,
  ADD COLUMN IF NOT EXISTS payout_account_name TEXT,
  ADD COLUMN IF NOT EXISTS payout_recipient_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_payout_recipient
  ON drivers(payout_recipient_code)
  WHERE payout_recipient_code IS NOT NULL;
