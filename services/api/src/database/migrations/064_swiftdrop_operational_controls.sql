-- SwiftDrop operational controls: parcel metadata, escrow timing, dispute SLAs,
-- notification channels, fraud signals, risk zones and production onboarding gates.

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS voice_note_url TEXT,
  ADD COLUMN IF NOT EXISTS entrance_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS receiver_pin_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receiver_pin_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrival_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_dispute_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_release_eligible_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS insurance_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS insurance_premium_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fuel_surcharge_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ev_courier_discount_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parcel_info_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parcel_info_confirmed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pickup_gps_mismatch BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS retraining_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS merchant_visibility_reduced BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fraud_flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS device_fingerprint_hash TEXT,
  ADD COLUMN IF NOT EXISTS session_expires_at TIMESTAMPTZ;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS escrow_held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_dispute_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS release_reason TEXT;

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS dispute_sla_policies (
  reason TEXT PRIMARY KEY,
  first_response_hours INTEGER NOT NULL,
  resolution_hours INTEGER NOT NULL
);
INSERT INTO dispute_sla_policies(reason, first_response_hours, resolution_hours) VALUES
  ('NOT_DELIVERED',2,24),
  ('DAMAGED',4,48),
  ('WRONG_ITEM',4,48),
  ('NOT_AS_DESCRIBED',4,48),
  ('PAYMENT_ISSUE',1,12),
  ('OTHER',4,48)
ON CONFLICT (reason) DO UPDATE SET
  first_response_hours=EXCLUDED.first_response_hours,
  resolution_hours=EXCLUDED.resolution_hours;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled BOOLEAN NOT NULL DEFAULT true,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  sms_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'IN_APP',
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE agent_notifications
  ADD COLUMN IF NOT EXISTS warning_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS fraud_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fraud_events_user_time ON fraud_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_events_delivery_time ON fraud_events(delivery_id, created_at DESC);

CREATE TABLE IF NOT EXISTS risk_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  polygon JSONB NOT NULL,
  high_risk BOOLEAN NOT NULL DEFAULT false,
  insurance_required BOOLEAN NOT NULL DEFAULT false,
  extra_verification_required BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courier_remittances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
  courier_id UUID NOT NULL REFERENCES users(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  due_at TIMESTAMPTZ NOT NULL,
  remitted_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE','REMETTED','OVERDUE','WAIVED')),
  return_fee_minor BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_rate_limits (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  order_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_deliveries_receiver_pin_lock ON deliveries(pin_locked_until);
CREATE INDEX IF NOT EXISTS idx_deliveries_escrow_dispute_until ON deliveries(escrow_dispute_until);
CREATE INDEX IF NOT EXISTS idx_deliveries_remittance_due ON deliveries(courier_remittance_due_at);
