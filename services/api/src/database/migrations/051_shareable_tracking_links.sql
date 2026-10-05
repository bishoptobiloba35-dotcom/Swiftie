CREATE TABLE IF NOT EXISTS delivery_tracking_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_tracking_links_delivery
  ON delivery_tracking_links(delivery_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_tracking_links_active
  ON delivery_tracking_links(token_hash)
  WHERE revoked_at IS NULL;