ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS notification_outbox_failed_at_idx
  ON notification_outbox(failed_at)
  WHERE failed_at IS NOT NULL;
