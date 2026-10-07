-- Track the last DVA requery attempt so concurrent API instances respect Paystack's
-- per-account ten-minute requery limit.
ALTER TABLE virtual_accounts
  ADD COLUMN IF NOT EXISTS last_requery_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_virtual_accounts_requery_due
  ON virtual_accounts(last_requery_at, updated_at)
  WHERE status='ACTIVE';
