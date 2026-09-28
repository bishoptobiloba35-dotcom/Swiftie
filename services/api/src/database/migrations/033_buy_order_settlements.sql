CREATE TABLE IF NOT EXISTS buy_order_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id UUID NOT NULL UNIQUE REFERENCES buy_orders(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agent_profiles(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','PAID','FAILED','REVERSED')),
  provider_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buy_order_settlements_agent_status ON buy_order_settlements(agent_id,status,created_at DESC);
