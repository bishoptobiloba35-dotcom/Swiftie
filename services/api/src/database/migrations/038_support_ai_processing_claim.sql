ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS ai_processing_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_support_tickets_ai_processing
  ON support_tickets(ai_processing_at)
  WHERE ai_processing_at IS NOT NULL;
