-- Harden Paystack DVA provisioning and delayed bank-transfer recovery.
ALTER TABLE virtual_accounts
  ALTER COLUMN account_number DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS provider_slug TEXT;

ALTER TABLE virtual_accounts DROP CONSTRAINT IF EXISTS virtual_accounts_status_check;
ALTER TABLE virtual_accounts
  ADD CONSTRAINT virtual_accounts_status_check
  CHECK (status IN ('PROVISIONING','ACTIVE','USED','EXPIRED','DISABLED','FAILED'));

CREATE INDEX IF NOT EXISTS idx_virtual_accounts_provisioning
  ON virtual_accounts(status,updated_at)
  WHERE status='PROVISIONING';

CREATE INDEX IF NOT EXISTS idx_escrow_bank_transfer_pending
  ON escrow_payment_attempts(order_id,updated_at)
  WHERE method='BANK_TRANSFER' AND status='PENDING';
