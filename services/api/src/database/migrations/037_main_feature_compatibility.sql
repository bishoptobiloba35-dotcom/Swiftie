-- Compatibility bridge for integrating the latest Business/AI/Buy & Deliver modules with SwiftDrop's existing feature migrations.

ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS registration_number TEXT;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS monthly_spend_limit_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS per_order_limit_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE business_accounts ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;
UPDATE business_accounts SET legal_name=COALESCE(legal_name,name), display_name=COALESCE(display_name,name) WHERE legal_name IS NULL OR display_name IS NULL;

ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id);
ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS delivery_window_start TIMESTAMPTZ;
ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS delivery_window_end TIMESTAMPTZ;
ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES users(id);
ALTER TABLE business_dispatch_plans ADD COLUMN IF NOT EXISTS plan JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE business_dispatch_plans SET plan=COALESCE(plan, jsonb_build_object('deliveryIds', COALESCE(groups,'[]'::jsonb))), estimated_total_minor=COALESCE(estimated_total_minor,0);

INSERT INTO business_members (business_id,user_id,member_role,spend_limit_minor)
SELECT id,owner_user_id,'OWNER',monthly_spend_limit_minor FROM business_accounts
WHERE NOT EXISTS (SELECT 1 FROM business_members bm WHERE bm.business_id=business_accounts.id AND bm.user_id=business_accounts.owner_user_id);
