CREATE TABLE IF NOT EXISTS paystack_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_hash TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  provider_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paystack_webhook_events_reference
  ON paystack_webhook_events(provider_reference)
  WHERE provider_reference IS NOT NULL;
