-- Competitive hardening: Instacart-style item-level replacement approvals for unified errands.
CREATE TABLE IF NOT EXISTS buy_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id UUID NOT NULL REFERENCES buy_orders(id) ON DELETE CASCADE,
  requested_description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  max_authorized_minor BIGINT,
  replacement_policy TEXT NOT NULL DEFAULT 'EXACT_ONLY'
    CHECK (replacement_policy IN ('EXACT_ONLY','BEST_MATCH','APPROVED_ALTERNATIVES','REFUND_IF_UNAVAILABLE')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','FOUND','REPLACEMENT_PENDING','APPROVED','REFUNDED','PURCHASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_order_items_order ON buy_order_items(buy_order_id, created_at);

CREATE TABLE IF NOT EXISTS buy_order_replacement_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES buy_order_items(id) ON DELETE CASCADE,
  proposed_description TEXT NOT NULL,
  proposed_quantity INTEGER NOT NULL DEFAULT 1 CHECK (proposed_quantity > 0),
  proposed_price_minor BIGINT NOT NULL CHECK (proposed_price_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  evidence_key TEXT,
  shopper_note TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','REFUNDED','EXPIRED')),
  proposed_by_agent_id UUID REFERENCES agent_profiles(id),
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buy_order_replacements_item_status
  ON buy_order_replacement_options(item_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_replacement_per_item
  ON buy_order_replacement_options(item_id)
  WHERE status = 'PENDING';

ALTER TABLE buy_orders
  ADD COLUMN IF NOT EXISTS replacement_review_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replacement_review_deadline TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_buy_orders_replacement_review
  ON buy_orders(replacement_review_required, replacement_review_deadline)
  WHERE replacement_review_required = true;

COMMENT ON TABLE buy_order_replacement_options IS
  'Errand shopper alternatives. Customer approval is required when policy does not authorize the proposed replacement.';
