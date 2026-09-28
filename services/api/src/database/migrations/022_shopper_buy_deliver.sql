CREATE TABLE IF NOT EXISTS shopper_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','SUSPENDED')),
  shopper_type TEXT NOT NULL DEFAULT 'SHOPPER' CHECK (shopper_type IN ('SHOPPER','ERRAND_PARTNER')),
  service_zones TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shopper_id UUID REFERENCES shopper_profiles(id) ON DELETE SET NULL,
  delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('BUY_AND_DELIVER','SHOP_FOR_ME','APPROVED_ERRAND','MERCHANT_PICKUP','RETURN')),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','AUTHORIZED','ASSIGNED','SHOPPING','AWAITING_APPROVAL','PURCHASED','DELIVERING','COMPLETED','CANCELLED','DISPUTED')),
  title TEXT NOT NULL,
  notes TEXT,
  destination_address TEXT,
  budget_minor INTEGER NOT NULL CHECK (budget_minor > 0),
  authorized_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (authorized_amount_minor >= 0),
  actual_amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES shopping_tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 1000),
  max_unit_price_minor INTEGER CHECK (max_unit_price_minor IS NULL OR max_unit_price_minor >= 0),
  substitution_policy TEXT NOT NULL DEFAULT 'ASK_FIRST' CHECK (substitution_policy IN ('NO_SUBSTITUTE','ASK_FIRST','SIMILAR_UNDER_BUDGET','CLOSEST_AVAILABLE')),
  found_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (found_status IN ('PENDING','FOUND','UNAVAILABLE','SUBSTITUTED')),
  actual_unit_price_minor INTEGER,
  actual_quantity INTEGER,
  substitute_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES shopping_tasks(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CAPTURED')),
  provider_reference TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES shopping_tasks(id) ON DELETE CASCADE,
  shopper_id UUID REFERENCES shopper_profiles(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('RECEIPT','ITEM_PHOTO','PURCHASE_CONFIRMATION','HANDOVER')),
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL UNIQUE REFERENCES shopping_tasks(id) ON DELETE CASCADE,
  budget_minor INTEGER NOT NULL,
  authorized_amount_minor INTEGER NOT NULL,
  actual_amount_minor INTEGER NOT NULL,
  refund_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_minor >= 0),
  additional_approval_minor INTEGER NOT NULL DEFAULT 0 CHECK (additional_approval_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','SETTLED','REQUIRES_APPROVAL','MANUAL_REVIEW')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopping_tasks_customer ON shopping_tasks(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopping_tasks_status ON shopping_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_shopping_tasks_shopper ON shopping_tasks(shopper_id, status);
CREATE INDEX IF NOT EXISTS idx_shopping_items_task ON shopping_items(task_id);
