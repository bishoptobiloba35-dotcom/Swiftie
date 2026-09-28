CREATE TABLE IF NOT EXISTS support_ai_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('AUTO_RESOLVED','ESCALATED','BLOCKED')),
  reason TEXT NOT NULL,
  response TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'SWIFTDROP_SUPPORT_AGENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ai_actions_ticket_created
  ON support_ai_actions(ticket_id, created_at DESC);

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS ai_handled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_action_id UUID REFERENCES support_ai_actions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS human_required BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_support_tickets_ai_queue
  ON support_tickets(status, ai_handled, human_required, created_at);