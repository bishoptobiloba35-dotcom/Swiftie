CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('USER','AI','ADMIN')),
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_created
  ON support_ticket_messages(ticket_id, created_at ASC);

INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_user_id, message)
SELECT id, 'USER', user_id, message
FROM support_tickets
WHERE NOT EXISTS (
  SELECT 1 FROM support_ticket_messages m WHERE m.ticket_id=support_tickets.id
);
