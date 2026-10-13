CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','DRIVER','ADMIN')),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  online BOOLEAN NOT NULL DEFAULT false,
  vehicle_type TEXT,
  vehicle_registration TEXT,
  payout_bank_code TEXT,
  payout_bank_name TEXT,
  payout_account_number TEXT,
  payout_account_name TEXT,
  payout_recipient_code TEXT,
  recipient_verified BOOLEAN NOT NULL DEFAULT false,
  recipient_verified_at TIMESTAMPTZ,
  payout_resolved_account_name TEXT,
  payout_account_name_entered TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_code TEXT NOT NULL UNIQUE,
  sender_id UUID NOT NULL REFERENCES users(id),
  driver_id UUID REFERENCES drivers(id),
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  pickup_lat NUMERIC(9,6),
  pickup_lng NUMERIC(9,6),
  dropoff_address TEXT NOT NULL,
  dropoff_lat NUMERIC(9,6),
  dropoff_lng NUMERIC(9,6),
  status TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED','PAYMENT_AUTHORIZED','DRIVER_ASSIGNED','DRIVER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED','CANCELLED','DISPUTED','RETURNED')),
  receiver_pin_hash TEXT NOT NULL,
  pickup_photo_url TEXT,
  quote_distance_meters INTEGER,
  quote_duration_seconds INTEGER,
  quote_base_fare_minor INTEGER,
  quote_distance_fare_minor INTEGER,
  quote_service_fee_minor INTEGER,
  quote_total_minor INTEGER,
  quote_currency CHAR(3) DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id),
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS location_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL,
  accuracy_meters NUMERIC(8,2),
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_location_events_delivery_time
  ON location_events(delivery_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id),
  provider TEXT NOT NULL,
  provider_reference TEXT UNIQUE,
  amount_minor INTEGER NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORIZED','HELD','RELEASED','REFUNDED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Bootstrap-schema parity for the production escrow payment-attempt contract.
CREATE TABLE IF NOT EXISTS escrow_payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  payer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payer_role TEXT NOT NULL DEFAULT 'SENDER' CHECK (payer_role IN ('SENDER','RECEIVER')),
  provider TEXT NOT NULL DEFAULT 'paystack',
  method TEXT NOT NULL CHECK (method IN ('PAYSTACK_CARD','BANK_TRANSFER','USSD','SMS_LINK')),
  provider_reference TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  collection_channel TEXT NOT NULL DEFAULT 'CARD' CHECK (collection_channel IN ('CARD','BANK_TRANSFER','USSD')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','EXPIRED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS escrow_payment_attempts_provider_reference_unique
  ON escrow_payment_attempts(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS escrow_payment_attempts_one_pending_per_order
  ON escrow_payment_attempts(order_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS idx_escrow_payment_attempts_order
  ON escrow_payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_escrow_attempts_payer
  ON escrow_payment_attempts(order_id,payer_role,status);
CREATE INDEX IF NOT EXISTS idx_escrow_bank_transfer_pending
  ON escrow_payment_attempts(order_id,updated_at)
  WHERE method='BANK_TRANSFER' AND status='PENDING';



CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  amount_minor INTEGER NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ELIGIBLE','PROCESSING','RELEASED','FAILED','CANCELLED','REVERSED')),
  provider TEXT,
  provider_reference TEXT UNIQUE,
  fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  net_amount_minor INTEGER CHECK (net_amount_minor IS NULL OR net_amount_minor > 0),
  idempotency_key TEXT,
  provider_transfer_code TEXT,
  requires_admin_approval BOOLEAN NOT NULL DEFAULT false,
  admin_approved_at TIMESTAMPTZ,
  admin_approved_by UUID REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payouts_idempotency_key_uniq
  ON payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS payouts_driver_id_idx ON payouts(driver_id);
CREATE INDEX IF NOT EXISTS payouts_status_active_idx ON payouts(status)
  WHERE status IN ('PENDING','PROCESSING','ELIGIBLE');
CREATE INDEX IF NOT EXISTS payouts_provider_reference_idx
  ON payouts(provider, provider_reference);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed','ignored')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL DEFAULT 'paystack',
  paystack_count INTEGER NOT NULL,
  local_count INTEGER NOT NULL,
  mismatches_found INTEGER NOT NULL,
  mismatches_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_payout_request_limits (
  driver_id UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  last_requested_at TIMESTAMPTZ NOT NULL
);


CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id),
  opened_by UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED_REFUND','RESOLVED_RELEASE','CLOSED')),
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);



CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivery_id UUID REFERENCES deliveries(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('IOS','ANDROID')),
  push_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

CREATE TABLE IF NOT EXISTS driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  document_type TEXT NOT NULL,
  document_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_documents_driver ON driver_documents(driver_id);


-- Business/merchant mode fields are also present in the CI bootstrap schema.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'INDIVIDUAL',
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN IF NOT EXISTS business_role TEXT;

CREATE TABLE IF NOT EXISTS business_role_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('MERCHANT','DRIVER','AGENT','ERRAND')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);


-- CI/bootstrap schema alignment for pricing v2.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS quote_express_surcharge_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_fuel_surcharge_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_version TEXT DEFAULT 'v2',
  ADD COLUMN IF NOT EXISTS quote_weight_fare_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_size_fare_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_perishable_surcharge_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_fuel_reference_minor BIGINT,
  ADD COLUMN IF NOT EXISTS quote_protection_reserve_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quote_pricing_version INTEGER;

CREATE TABLE IF NOT EXISTS pricing_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL UNIQUE,
  fuel_price_minor_per_litre BIGINT NOT NULL CHECK (fuel_price_minor_per_litre > 0),
  fuel_source TEXT NOT NULL CHECK (length(trim(fuel_source)) >= 3),
  service_charge_bps INTEGER NOT NULL DEFAULT 1000 CHECK (service_charge_bps >= 0 AND service_charge_bps <= 5000),
  protection_reserve_bps INTEGER NOT NULL DEFAULT 500 CHECK (protection_reserve_bps >= 0 AND protection_reserve_bps <= 5000),
  perishable_surcharge_bps INTEGER NOT NULL DEFAULT 1500 CHECK (perishable_surcharge_bps >= 0 AND perishable_surcharge_bps <= 5000),
  role_charge_bps INTEGER NOT NULL DEFAULT 1000 CHECK (role_charge_bps >= 0 AND role_charge_bps <= 5000),
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_configs_effective ON pricing_configs(effective_at DESC, version DESC);

-- RLS bootstrap parity for core user, delivery, and payment records.
-- Trusted API access uses its server database role; non-owner roles require a
-- verified request.jwt.claim.sub and receive no financial write policies.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select_self ON users;
CREATE POLICY users_select_self ON users FOR SELECT
  USING (id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drivers_select_self ON drivers;
CREATE POLICY drivers_select_self ON drivers FOR SELECT
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deliveries_select_participant ON deliveries;
CREATE POLICY deliveries_select_participant ON deliveries FOR SELECT
  USING (
    sender_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    OR driver_id IN (
      SELECT d.id FROM drivers d
       WHERE d.user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    )
  );

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_events_select_participant ON delivery_events;
CREATE POLICY delivery_events_select_participant ON delivery_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = delivery_events.delivery_id));

ALTER TABLE location_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_events_select_participant ON location_events;
CREATE POLICY location_events_select_participant ON location_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = location_events.delivery_id));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payments_select_delivery_participant ON payments;
CREATE POLICY payments_select_delivery_participant ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = payments.delivery_id));

ALTER TABLE escrow_payment_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS escrow_attempts_select_delivery_participant ON escrow_payment_attempts;
CREATE POLICY escrow_attempts_select_delivery_participant ON escrow_payment_attempts FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = escrow_payment_attempts.order_id));

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS disputes_select_delivery_participant ON disputes;
CREATE POLICY disputes_select_delivery_participant ON disputes FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = disputes.delivery_id));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select_self ON notifications;
CREATE POLICY notifications_select_self ON notifications FOR SELECT
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_tokens_manage_self ON device_tokens;
CREATE POLICY device_tokens_manage_self ON device_tokens FOR ALL
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_documents_select_owner ON driver_documents;
CREATE POLICY driver_documents_select_owner ON driver_documents FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM drivers d
     WHERE d.id = driver_documents.driver_id
       AND d.user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  ));

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;


-- Provider/financial operational tables are trusted-server-only.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_payout_request_limits ENABLE ROW LEVEL SECURITY;
