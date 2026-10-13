-- Foundation Item 3: database-level authorization boundaries.
-- The API is the trusted application boundary and connects as the table owner/service role.
-- Non-owner client roles must present a verified subject in request.jwt.claim.sub.
-- Financial mutation tables intentionally have no end-user write policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase anon role is absent; RLS still applies to any non-owner role granted table access';
  END IF;
END $$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select_self ON users;
CREATE POLICY users_select_self ON users FOR SELECT
  USING (id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drivers_select_self ON drivers;
CREATE POLICY drivers_select_self ON drivers FOR SELECT
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deliveries_select_participant ON deliveries;
CREATE POLICY deliveries_select_participant ON deliveries FOR SELECT
  USING (
    sender_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    OR driver_id IN (
      SELECT d.id FROM drivers d
       WHERE d.user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
    )
  );

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_events_select_participant ON delivery_events;
CREATE POLICY delivery_events_select_participant ON delivery_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = delivery_events.delivery_id));

ALTER TABLE location_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_events_select_participant ON location_events;
CREATE POLICY location_events_select_participant ON location_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = location_events.delivery_id));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payments_select_delivery_participant ON payments;
CREATE POLICY payments_select_delivery_participant ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = payments.delivery_id));

ALTER TABLE escrow_payment_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS escrow_attempts_select_delivery_participant ON escrow_payment_attempts;
CREATE POLICY escrow_attempts_select_delivery_participant ON escrow_payment_attempts FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = escrow_payment_attempts.order_id));

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS disputes_select_delivery_participant ON disputes;
CREATE POLICY disputes_select_delivery_participant ON disputes FOR SELECT
  USING (EXISTS (SELECT 1 FROM deliveries d WHERE d.id = disputes.delivery_id));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select_self ON notifications;
CREATE POLICY notifications_select_self ON notifications FOR SELECT
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_tokens_manage_self ON device_tokens;
CREATE POLICY device_tokens_manage_self ON device_tokens FOR ALL
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_documents_select_owner ON driver_documents;
CREATE POLICY driver_documents_select_owner ON driver_documents FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM drivers d
     WHERE d.id = driver_documents.driver_id
       AND d.user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  ));

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_tickets_select_self ON support_tickets;
CREATE POLICY support_tickets_select_self ON support_tickets FOR SELECT
  USING (user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid);

-- Wallets, settlement requests, payout ledgers, float ledger and financial write paths
-- deliberately have RLS enabled without end-user policies: non-owner roles are denied.
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE stakeholder_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE float_transactions ENABLE ROW LEVEL SECURITY;
