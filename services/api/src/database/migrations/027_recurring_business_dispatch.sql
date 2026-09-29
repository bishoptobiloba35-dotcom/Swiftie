-- SwiftDrop recurring business dispatch automation.
CREATE TABLE IF NOT EXISTS business_recurring_dispatches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL CHECK (cadence_minutes >= 15 AND cadence_minutes <= 43200),
  next_run_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  approval_required BOOLEAN NOT NULL DEFAULT true,
  template JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at TIMESTAMPTZ,
  last_dispatch_plan_id UUID REFERENCES business_dispatch_plans(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_recurring_dispatch_due
  ON business_recurring_dispatches(active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_business_recurring_dispatch_business
  ON business_recurring_dispatches(business_id, active, created_at DESC);
