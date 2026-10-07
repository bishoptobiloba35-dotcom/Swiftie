-- Phase 2: all receiver payments are in-app escrow. Cash-on-delivery is retired.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS merchant_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ALTER COLUMN payment_on_delivery SET DEFAULT false;

UPDATE deliveries
SET payment_on_delivery = false
WHERE payment_on_delivery IS DISTINCT FROM false;

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS escrow_payment_state TEXT NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN IF NOT EXISTS escrow_total_paid_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_courier_share_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_service_charge_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_protection_reserve_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_swiftdrop_margin_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_merchant_share_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_pin_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_dispute_window_until TIMESTAMPTZ;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_no_cash_payment_check CHECK (payment_on_delivery = false);

CREATE TABLE IF NOT EXISTS escrow_ledgers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'NGN',
  total_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_paid_minor >= 0),
  courier_share_minor BIGINT NOT NULL DEFAULT 0 CHECK (courier_share_minor >= 0),
  service_charge_minor BIGINT NOT NULL DEFAULT 0 CHECK (service_charge_minor >= 0),
  protection_reserve_minor BIGINT NOT NULL DEFAULT 0 CHECK (protection_reserve_minor >= 0),
  swiftdrop_margin_minor BIGINT NOT NULL DEFAULT 0 CHECK (swiftdrop_margin_minor >= 0),
  merchant_share_minor BIGINT NOT NULL DEFAULT 0 CHECK (merchant_share_minor >= 0),
  state TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (state IN ('pending_payment','paid_escrow','picked_up','in_transit','arrived','pin_confirmed','dispute_window','released','returned','refunded','disputed')),
  provider TEXT,
  provider_reference TEXT,
  funded_at TIMESTAMPTZ,
  pin_confirmed_at TIMESTAMPTZ,
  dispute_window_until TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  stakeholder_release_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_ledgers_provider_reference
  ON escrow_ledgers(provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS virtual_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'paystack',
  customer_code TEXT,
  account_name TEXT,
  account_number TEXT NOT NULL,
  bank_name TEXT,
  bank_code TEXT,
  provider_reference TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXPIRED','DISABLED')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id)
);

CREATE TABLE IF NOT EXISTS stakeholder_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stakeholder_type TEXT NOT NULL CHECK (stakeholder_type IN ('COURIER','MERCHANT','AGENT','ERRAND_RUNNER','CUSTOMER')),
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  pending_minor BIGINT NOT NULL DEFAULT 0 CHECK (pending_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  paystack_recipient_code TEXT,
  bank_account_verified BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES stakeholder_wallets(id) ON DELETE CASCADE,
  order_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  balance_after_minor BIGINT,
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES stakeholder_wallets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 100000),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','RELEASED','FAILED','CANCELLED')),
  provider TEXT NOT NULL DEFAULT 'paystack',
  provider_reference TEXT,
  failure_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS float_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('FUNDING','ESCROW_IN','ESCROW_OUT','PAYOUT','REFUND','TOP_UP','INTEREST')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  balance_after_minor BIGINT NOT NULL CHECK (balance_after_minor >= 0),
  provider_reference TEXT,
  order_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escrow_payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('PAYSTACK_CARD','BANK_TRANSFER','USSD','SMS_LINK')),
  provider_reference TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','EXPIRED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_time ON wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_requests_user_time ON payout_requests(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_float_transactions_time ON float_transactions(created_at DESC);

-- Retire the legacy cash collection mode from both new and existing records.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_payment_mode_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_collection_mode_check;
UPDATE deliveries SET payment_mode='SENDER_ESCROW' WHERE payment_mode='RECEIVER_ON_DELIVERY';
UPDATE payments SET collection_mode='SENDER_ESCROW', escrow_status='PENDING' WHERE collection_mode='RECEIVER_ON_DELIVERY';
ALTER TABLE deliveries ADD CONSTRAINT deliveries_payment_mode_check CHECK (payment_mode IN ('SENDER_ESCROW','RECEIVER_ON_DELIVERY'));
ALTER TABLE payments ADD CONSTRAINT payments_collection_mode_check CHECK (collection_mode IN ('SENDER_ESCROW','RECEIVER_ON_DELIVERY'));


-- Compatibility note: historical fixtures may still construct RECEIVER_ON_DELIVERY.
-- The application/API must reject it as a live payment mode; the DB accepts the legacy
-- enum value only so old fixtures and historical rows can be migrated safely without
-- breaking the migration itself. New production writes are blocked by the API boundary.
