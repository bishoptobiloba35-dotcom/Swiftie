-- Foundation Item 4: additive driver-transfer contract.
-- Preserve the existing delivery-linked payout state machine used by escrow release.
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS recipient_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recipient_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_resolved_account_name TEXT,
  ADD COLUMN IF NOT EXISTS payout_account_name_entered TEXT;

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  ADD COLUMN IF NOT EXISTS net_amount_minor INTEGER,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS provider_transfer_code TEXT,
  ADD COLUMN IF NOT EXISTS requires_admin_approval BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE payouts
   SET net_amount_minor = amount_minor,
       idempotency_key = COALESCE(idempotency_key, 'legacy-payout-' || id::text),
       requested_at = COALESCE(requested_at, created_at)
 WHERE net_amount_minor IS NULL OR idempotency_key IS NULL OR requested_at IS NULL;

ALTER TABLE payouts
  ALTER COLUMN requested_at SET DEFAULT now();

-- Keep the existing uppercase state convention while making reversals explicit.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
  CHECK (status IN ('PENDING','ELIGIBLE','PROCESSING','RELEASED','FAILED','CANCELLED','REVERSED'));

-- Legacy delivery-eligible payouts may not yet have transfer idempotency keys.
-- The driver-transfer route sets the key before calling Paystack.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_idempotency_key_uniq
  ON payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS payouts_driver_id_idx ON payouts(driver_id);
CREATE INDEX IF NOT EXISTS payouts_status_active_idx ON payouts(status)
  WHERE status IN ('PENDING','PROCESSING','ELIGIBLE');
CREATE INDEX IF NOT EXISTS payouts_provider_reference_idx
  ON payouts(provider, provider_reference);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed','ignored')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider TEXT NOT NULL DEFAULT 'paystack',
  paystack_count INTEGER NOT NULL,
  local_count INTEGER NOT NULL,
  mismatches_found INTEGER NOT NULL,
  mismatches_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_payout_request_limits (
  driver_id UUID PRIMARY KEY REFERENCES drivers(id) ON DELETE CASCADE,
  last_requested_at TIMESTAMPTZ NOT NULL
);

-- New operational tables contain financial/provider metadata; only the trusted API role
-- should access them directly. No end-user RLS policies are created.
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_payout_request_limits ENABLE ROW LEVEL SECURITY;
