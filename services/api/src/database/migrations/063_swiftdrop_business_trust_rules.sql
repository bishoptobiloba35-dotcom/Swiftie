-- SwiftDrop business rules and trust-score foundation.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER','MERCHANT','DRIVER','AGENT','ERRAND','ADMIN','SUPPORT','FINANCE'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'INDIVIDUAL';
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'NOT_STARTED';
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT DEFAULT 'system';
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score NUMERIC(5,2) NOT NULL DEFAULT 50;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_delivery_success NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_on_time NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_photo_compliance NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_rating NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_dispute_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS landmark TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS pin_lat_lng JSONB;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,2);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS size_category TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS declared_value_minor BIGINT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS perishable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS quote_protection_reserve_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS protection_opted_in BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS payment_on_delivery BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS escrow_released_at TIMESTAMPTZ;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS delivery_photo_url TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS trust_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  order_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  value NUMERIC(12,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trust_events_user_created ON trust_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_role_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('MERCHANT','DRIVER','AGENT','ERRAND')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);

CREATE TABLE IF NOT EXISTS courier_onboarding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  day1_completed_at TIMESTAMPTZ,
  day2_completed_at TIMESTAMPTZ,
  day2_deliveries INTEGER NOT NULL DEFAULT 0,
  day3_completed_at TIMESTAMPTZ,
  day3_deliveries INTEGER NOT NULL DEFAULT 0,
  supervisor_approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pod_return_fee_minor BIGINT,
  ADD COLUMN IF NOT EXISTS courier_remittance_due_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS agent_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  agent_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  dispatched_at TIMESTAMPTZ,
  sla_due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS errand_deal_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  errand_id UUID NOT NULL,
  item_description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  where_to_buy TEXT NOT NULL,
  goods_budget_minor BIGINT NOT NULL CHECK (goods_budget_minor <= 5000000),
  errand_fee_minor BIGINT NOT NULL CHECK (errand_fee_minor >= 30000),
  total_minor BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED',
  proposed_by UUID REFERENCES users(id),
  accepted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_trust_score_check;
ALTER TABLE users ADD CONSTRAINT users_trust_score_check CHECK (trust_score BETWEEN 0 AND 100);

COMMENT ON COLUMN users.trust_score IS '30% delivery success + 20% on-time + 15% photo compliance + 20% normalized rating + 15% inverse dispute rate; new users start at 50.';
COMMENT ON COLUMN deliveries.protection_opted_in IS '10% declared-value protection reserve; enabled by default.';
