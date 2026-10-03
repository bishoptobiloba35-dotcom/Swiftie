ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS pickup_address TEXT,
  ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS length_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS width_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS is_perishable BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS delivery_id UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (fulfillment_status IN ('NOT_STARTED','READY','IN_PROGRESS','FULFILLED','CANCELLED'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_delivery_id
  ON marketplace_orders(delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_fulfillment
  ON marketplace_orders(fulfillment_status, updated_at DESC);
