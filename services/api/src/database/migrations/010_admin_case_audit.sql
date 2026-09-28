CREATE TABLE IF NOT EXISTS admin_case_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
  admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  note TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_case_audit_delivery
  ON admin_case_audit(delivery_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_case_audit_dispute
  ON admin_case_audit(dispute_id, created_at DESC);
