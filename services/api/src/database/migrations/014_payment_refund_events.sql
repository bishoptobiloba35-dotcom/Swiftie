CREATE TABLE IF NOT EXISTS payment_refund_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  refund_reference TEXT NOT NULL,
  refund_status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, refund_reference)
);

CREATE INDEX IF NOT EXISTS idx_payment_refund_events_delivery
  ON payment_refund_events(delivery_id, created_at DESC);
