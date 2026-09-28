-- SwiftDrop Buy & Deliver operational lifecycle hardening.
ALTER TABLE buy_orders
  ADD COLUMN IF NOT EXISTS actual_purchase_minor BIGINT,
  ADD COLUMN IF NOT EXISTS purchase_receipt_key TEXT,
  ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL;

ALTER TABLE buy_orders
  ALTER COLUMN purchase_budget_minor TYPE BIGINT;

CREATE INDEX IF NOT EXISTS idx_buy_orders_unassigned_status
  ON buy_orders(status, created_at ASC)
  WHERE agent_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_buy_orders_delivery
  ON buy_orders(delivery_id);

CREATE TABLE IF NOT EXISTS agent_action_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  buy_order_id UUID REFERENCES buy_orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_action_events_order_time
  ON agent_action_events(buy_order_id, created_at DESC);
