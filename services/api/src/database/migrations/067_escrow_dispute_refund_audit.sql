-- Escrow dispute/refund audit state for Phase 2 provider reconciliation.
CREATE TABLE IF NOT EXISTS escrow_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  transaction_reference TEXT NOT NULL,
  provider_reference TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','NEEDS_ATTENTION','PROCESSED','FAILED')),
  dispute_id UUID REFERENCES disputes(id) ON DELETE SET NULL,
  initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_refunds_provider_reference
  ON escrow_refunds(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_escrow_refunds_order_status
  ON escrow_refunds(order_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrow_refunds_transaction
  ON escrow_refunds(transaction_reference,status);

-- An open dispute is a financial hold. The 72-hour release worker must never
-- release an escrow ledger that has entered the dispute state.
