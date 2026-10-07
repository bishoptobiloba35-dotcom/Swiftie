ALTER TABLE paystack_webhook_events
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'COMPLETED',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

UPDATE paystack_webhook_events
SET processing_status='COMPLETED',
    completed_at=COALESCE(completed_at,received_at)
WHERE processing_status IS NULL OR processing_status='COMPLETED';

ALTER TABLE paystack_webhook_events DROP CONSTRAINT IF EXISTS paystack_webhook_events_processing_status_check;
ALTER TABLE paystack_webhook_events
  ADD CONSTRAINT paystack_webhook_events_processing_status_check
  CHECK (processing_status IN ('PROCESSING','COMPLETED','FAILED'));

CREATE INDEX IF NOT EXISTS idx_paystack_webhook_events_processing
  ON paystack_webhook_events(processing_status,received_at);
