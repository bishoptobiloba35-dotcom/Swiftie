-- Delivery attributes required by Buy & Deliver and parcel pricing flows.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_deliveries_perishable_created
  ON deliveries(is_perishable, created_at DESC);
