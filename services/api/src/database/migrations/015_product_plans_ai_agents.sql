CREATE TABLE IF NOT EXISTS user_plans (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  individual_plan TEXT NOT NULL DEFAULT 'BASIC' CHECK (individual_plan IN ('BASIC','PREMIUM')),
  business_plan TEXT NOT NULL DEFAULT 'NONE' CHECK (business_plan IN ('NONE','BASIC','PREMIUM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_permissions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'ASSIST' CHECK (mode IN ('ASSIST','AUTHORIZED','AUTONOMOUS')),
  auto_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_pay_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (auto_pay_limit_minor >= 0),
  daily_spend_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (daily_spend_limit_minor >= 0),
  daily_spend_used_minor INTEGER NOT NULL DEFAULT 0 CHECK (daily_spend_used_minor >= 0),
  preferred_vehicle TEXT,
  max_delivery_cost_minor INTEGER CHECK (max_delivery_cost_minor IS NULL OR max_delivery_cost_minor >= 0),
  approval_threshold_minor INTEGER CHECK (approval_threshold_minor IS NULL OR approval_threshold_minor >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_action_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','APPROVED','EXECUTED','REJECTED','FAILED')),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  target_type TEXT,
  target_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_action_audit_user_created
  ON ai_action_audit(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_accounts_owner
  ON business_accounts(owner_user_id);

CREATE TABLE IF NOT EXISTS business_ai_rules (
  business_id UUID PRIMARY KEY REFERENCES business_accounts(id) ON DELETE CASCADE,
  auto_dispatch_enabled BOOLEAN NOT NULL DEFAULT false,
  weekday_schedule TEXT,
  daily_spend_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (daily_spend_limit_minor >= 0),
  approval_threshold_minor INTEGER NOT NULL DEFAULT 0 CHECK (approval_threshold_minor >= 0),
  max_delivery_cost_minor INTEGER,
  preferred_vehicle TEXT,
  auto_replace_cancelled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  category TEXT NOT NULL,
  address TEXT NOT NULL,
  services TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UNDER_REVIEW','APPROVED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_applications_user
  ON agent_applications(applicant_user_id, created_at DESC);
