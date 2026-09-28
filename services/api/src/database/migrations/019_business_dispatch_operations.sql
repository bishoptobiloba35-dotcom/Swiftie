CREATE TABLE IF NOT EXISTS business_deliveries (
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  delivery_id UUID PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','DISPATCHED','COMPLETED','CANCELLED')),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0 AND priority <= 100),
  scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_deliveries_ready
  ON business_deliveries(business_id, status, scheduled_for, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS business_dispatch_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','EXECUTED','SKIPPED','FAILED')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_dispatch_audit_business_created
  ON business_dispatch_audit(business_id, created_at DESC);