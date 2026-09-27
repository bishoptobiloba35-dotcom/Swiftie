CREATE TABLE IF NOT EXISTS receiver_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  receiver_phone TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(delivery_id, receiver_phone)
);

CREATE INDEX IF NOT EXISTS idx_receiver_ratings_driver ON receiver_ratings(driver_id, created_at DESC);
