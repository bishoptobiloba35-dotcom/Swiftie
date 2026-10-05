-- Unified SwiftDrop Errand service: shopping and purchase tasks are capabilities of Hire an Errand.
ALTER TABLE buy_orders
  ADD COLUMN IF NOT EXISTS errand_type TEXT NOT NULL DEFAULT 'PURCHASE_AND_DELIVER',
  ADD COLUMN IF NOT EXISTS replacement_policy TEXT NOT NULL DEFAULT 'EXACT_ONLY',
  ADD COLUMN IF NOT EXISTS max_price_delta_minor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS errand_instructions TEXT,
  ADD COLUMN IF NOT EXISTS requested_completion_at TIMESTAMPTZ;

ALTER TABLE buy_orders DROP CONSTRAINT IF EXISTS buy_orders_errand_type_check;
ALTER TABLE buy_orders ADD CONSTRAINT buy_orders_errand_type_check
  CHECK (errand_type IN ('GENERAL_ERRAND','PURCHASE_AND_DELIVER','SHOP_FOR_ME'));

ALTER TABLE buy_orders DROP CONSTRAINT IF EXISTS buy_orders_replacement_policy_check;
ALTER TABLE buy_orders ADD CONSTRAINT buy_orders_replacement_policy_check
  CHECK (replacement_policy IN ('EXACT_ONLY','BEST_MATCH','APPROVED_ALTERNATIVES','REFUND_IF_UNAVAILABLE'));

CREATE INDEX IF NOT EXISTS idx_buy_orders_errand_type_status
  ON buy_orders(errand_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buy_orders_requested_completion
  ON buy_orders(requested_completion_at)
  WHERE requested_completion_at IS NOT NULL;

COMMENT ON COLUMN buy_orders.errand_type IS
  'Unified Hire an Errand capability. GENERAL_ERRAND covers ordinary errands, PURCHASE_AND_DELIVER covers buying a specified item, and SHOP_FOR_ME covers open-ended shopping.';
COMMENT ON COLUMN buy_orders.purchase_budget_minor IS
  'Customer-authorized spending ceiling for the errand; never a permission to exceed the stated amount.';
