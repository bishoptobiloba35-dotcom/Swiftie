ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS proof_requirements JSONB NOT NULL DEFAULT '{"pickup":["PHOTO"],"dropoff":["PIN"]}'::jsonb;

CREATE TABLE IF NOT EXISTS delivery_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  proof_type TEXT NOT NULL CHECK (proof_type IN ('PHOTO','SIGNATURE','BARCODE','ID')),
  phase TEXT NOT NULL CHECK (phase IN ('PICKUP','DROPOFF')),
  storage_key TEXT,
  proof_value TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, phase, proof_type)
);

CREATE INDEX IF NOT EXISTS idx_delivery_proofs_delivery
  ON delivery_proofs(delivery_id, phase, created_at DESC);

ALTER TABLE delivery_proofs
  DROP CONSTRAINT IF EXISTS delivery_proofs_value_presence_check;

ALTER TABLE delivery_proofs
  ADD CONSTRAINT delivery_proofs_value_presence_check
  CHECK (storage_key IS NOT NULL OR proof_value IS NOT NULL);
