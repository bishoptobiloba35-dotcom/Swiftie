CREATE TABLE IF NOT EXISTS notification_push_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  status TEXT,
  error_code TEXT,
  message TEXT,
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_push_receipts_pending
  ON notification_push_receipts(ticket_id)
  WHERE checked_at IS NULL;
