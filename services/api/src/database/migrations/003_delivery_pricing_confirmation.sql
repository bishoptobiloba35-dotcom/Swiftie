ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS length_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS width_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS receiver_confirmed_at TIMESTAMPTZ;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS escrow_status TEXT NOT NULL DEFAULT 'HELD'
    CHECK (escrow_status IN ('PENDING','HELD','RELEASED','REFUNDED'));

CREATE INDEX IF NOT EXISTS idx_deliveries_payment_ready
  ON deliveries(status, driver_id, created_at);

CREATE INDEX IF NOT EXISTS idx_deliveries_receiver_confirmation
  ON deliveries(tracking_code, receiver_phone);