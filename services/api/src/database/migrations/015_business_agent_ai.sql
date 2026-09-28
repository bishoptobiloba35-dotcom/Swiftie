-- SwiftDrop production business, agent and AI entitlement foundation.
-- Migration is additive and safe to run after the existing 014 payment-refund-events migration.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('CUSTOMER','DRIVER','AGENT','ADMIN'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_plan TEXT NOT NULL DEFAULT 'BASIC'
    CHECK (ai_plan IN ('BASIC','PREMIUM'));

CREATE TABLE IF NOT EXISTS agent_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  service_radius_km NUMERIC(8,2) NOT NULL DEFAULT 10,
  max_purchase_minor INTEGER NOT NULL DEFAULT 10000000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_status ON agent_profiles(status);

CREATE TABLE IF NOT EXISTS business_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  registration_number TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
  monthly_spend_limit_minor BIGINT NOT NULL DEFAULT 0,
  per_order_limit_minor INTEGER NOT NULL DEFAULT 0,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_accounts_owner ON business_accounts(owner_user_id);

CREATE TABLE IF NOT EXISTS business_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL
    CHECK (member_role IN ('OWNER','ADMIN','DISPATCHER','VIEWER')),
  spend_limit_minor BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id, active);

CREATE TABLE IF NOT EXISTS buy_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL REFERENCES users(id),
  business_id UUID REFERENCES business_accounts(id),
  agent_id UUID REFERENCES agent_profiles(id),
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','APPROVED','AGENT_ASSIGNED','PURCHASING','PURCHASED','IN_TRANSIT','DELIVERED','CANCELLED','DISPUTED')),
  item_description TEXT NOT NULL,
  merchant_name TEXT,
  merchant_address TEXT,
  purchase_budget_minor INTEGER NOT NULL,
  delivery_fee_minor INTEGER,
  total_authorized_minor INTEGER,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_orders_customer ON buy_orders(customer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buy_orders_agent_status ON buy_orders(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_buy_orders_business ON buy_orders(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS buy_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id UUID NOT NULL REFERENCES buy_orders(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_order_events_order_time
  ON buy_order_events(buy_order_id, created_at ASC);

CREATE TABLE IF NOT EXISTS business_dispatch_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PREPARED'
    CHECK (status IN ('PREPARED','APPROVED','EXECUTED','CANCELLED')),
  delivery_window_start TIMESTAMPTZ,
  delivery_window_end TIMESTAMPTZ,
  estimated_total_minor BIGINT NOT NULL DEFAULT 0,
  approval_required BOOLEAN NOT NULL DEFAULT false,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_dispatch_business_status
  ON business_dispatch_plans(business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL CHECK (plan IN ('BASIC','PREMIUM')),
  capability TEXT NOT NULL,
  action TEXT,
  allowed BOOLEAN NOT NULL,
  reason TEXT,
  request_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_user_time
  ON ai_audit_log(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_entitlement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  old_plan TEXT NOT NULL CHECK (old_plan IN ('BASIC','PREMIUM')),
  new_plan TEXT NOT NULL CHECK (new_plan IN ('BASIC','PREMIUM')),
  changed_by_user_id UUID REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_entitlement_events_user_time
  ON ai_entitlement_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_spend_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  reference_type TEXT NOT NULL,
  reference_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_spend_ledger_business_time
  ON business_spend_ledger(business_id, created_at DESC);
