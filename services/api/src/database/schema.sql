CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','DRIVER','ADMIN')),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
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
  status TEXT NOT NULL DEFAULT 'CREATED',
  receiver_pin_hash TEXT NOT NULL,
  pickup_photo_url TEXT,
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
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
