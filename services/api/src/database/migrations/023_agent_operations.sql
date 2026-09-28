CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL UNIQUE REFERENCES agent_applications(id) ON DELETE RESTRICT,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_code TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  category TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_capacity INTEGER NOT NULL DEFAULT 0 CHECK (storage_capacity >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  services TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('DROP_OFF','PICKUP','RELEASE')),
  verification_code TEXT,
  condition_note TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','RELEASED','REJECTED')),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_delivery_active
ON agent_shipments(agent_id, delivery_id, action)
WHERE status IN ('PENDING','ACCEPTED');

CREATE TABLE IF NOT EXISTS agent_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_shipment_id UUID NOT NULL REFERENCES agent_shipments(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('PARCEL_CONDITION','HANDOVER','QR_SCAN')),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_shipment_id UUID NOT NULL REFERENCES agent_shipments(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AVAILABLE','PAID','VOID')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agent_shipments_delivery ON agent_shipments(delivery_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_shipments_agent ON agent_shipments(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_agent ON agent_commissions(agent_id, status, created_at DESC);
