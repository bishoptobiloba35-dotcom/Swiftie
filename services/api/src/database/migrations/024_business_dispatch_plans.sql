CREATE TABLE IF NOT EXISTS business_dispatch_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','APPROVED','EXECUTED','CANCELLED')),
  preferred_vehicle TEXT,
  estimated_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (estimated_total_minor >= 0),
  order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_business_dispatch_plans_business ON business_dispatch_plans(business_id,created_at DESC);