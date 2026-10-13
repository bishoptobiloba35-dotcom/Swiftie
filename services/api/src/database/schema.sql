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


CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  amount_minor INTEGER NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ELIGIBLE','PROCESSING','RELEASED','FAILED','CANCELLED')),
  provider TEXT,
  provider_reference TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);


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
