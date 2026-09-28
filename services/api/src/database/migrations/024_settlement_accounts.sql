-- Production payout recipients and settlement state for Buy & Deliver agents and physical drop-off partners.
CREATE TABLE IF NOT EXISTS agent_settlement_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL UNIQUE REFERENCES agent_profiles(id) ON DELETE CASCADE,
  recipient_code TEXT NOT NULL UNIQUE,
  bank_code TEXT NOT NULL,
  bank_name TEXT,
  account_name TEXT NOT NULL,
  account_last4 CHAR(4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drop_off_settlement_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL UNIQUE REFERENCES drop_off_locations(id) ON DELETE CASCADE,
  recipient_code TEXT NOT NULL UNIQUE,
  bank_code TEXT NOT NULL,
  bank_name TEXT,
  account_name TEXT NOT NULL,
  account_last4 CHAR(4) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  active BOOLEAN NOT NULL DEFAULT true,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE buy_order_settlements ADD COLUMN IF NOT EXISTS transfer_reference TEXT;
ALTER TABLE buy_order_settlements ADD COLUMN IF NOT EXISTS provider_status TEXT;
ALTER TABLE buy_order_settlements ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_buy_order_settlements_transfer_ref ON buy_order_settlements(transfer_reference) WHERE transfer_reference IS NOT NULL;
ALTER TABLE drop_off_commission_ledger ADD COLUMN IF NOT EXISTS provider_status TEXT;
ALTER TABLE drop_off_commission_ledger ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drop_off_commission_transfer_ref ON drop_off_commission_ledger(provider_reference) WHERE provider_reference IS NOT NULL;