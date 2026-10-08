-- MVP v1.2: two active escrow modes and explicit delivery types.
-- CASH and the retired RECEIVER_ON_DELIVERY contract remain rejected.
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'EXPRESS',
  ADD COLUMN IF NOT EXISTS goods_amount_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receiver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sender_deposit_amount_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS station_id UUID REFERENCES drop_off_locations(id) ON DELETE SET NULL;

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_payment_mode_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_collection_mode_check;

UPDATE deliveries
SET payment_mode='SENDER_ESCROW'
WHERE payment_mode='RECEIVER_ON_DELIVERY';

UPDATE payments
SET collection_mode='SENDER_ESCROW',
    escrow_status=CASE WHEN escrow_status='NOT_APPLICABLE' THEN 'PENDING' ELSE COALESCE(escrow_status,'PENDING') END
WHERE collection_mode='RECEIVER_ON_DELIVERY';

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_payment_mode_check
  CHECK (payment_mode IN ('SENDER_ESCROW','RECEIVER_ESCROW')),
  ADD CONSTRAINT deliveries_delivery_type_check
  CHECK (delivery_type IN ('EXPRESS','STANDARD')),
  ADD CONSTRAINT deliveries_goods_amount_check
  CHECK (goods_amount_minor >= 0),
  ADD CONSTRAINT deliveries_sender_deposit_check
  CHECK (sender_deposit_amount_minor >= 0);

ALTER TABLE payments
  ADD CONSTRAINT payments_collection_mode_check
  CHECK (collection_mode IN ('SENDER_ESCROW','RECEIVER_ESCROW'));

ALTER TABLE escrow_payment_attempts
  ADD COLUMN IF NOT EXISTS payer_role TEXT NOT NULL DEFAULT 'SENDER',
  ADD COLUMN IF NOT EXISTS collection_channel TEXT NOT NULL DEFAULT 'CARD';

ALTER TABLE escrow_payment_attempts
  DROP CONSTRAINT IF EXISTS escrow_payment_attempts_payer_role_check,
  DROP CONSTRAINT IF EXISTS escrow_payment_attempts_collection_channel_check;

ALTER TABLE escrow_payment_attempts
  ADD CONSTRAINT escrow_payment_attempts_payer_role_check
    CHECK (payer_role IN ('SENDER','RECEIVER')),
  ADD CONSTRAINT escrow_payment_attempts_collection_channel_check
    CHECK (collection_channel IN ('CARD','BANK_TRANSFER','USSD'));

CREATE INDEX IF NOT EXISTS idx_deliveries_receiver_user ON deliveries(receiver_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_payment_mode ON deliveries(payment_mode,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_delivery_type ON deliveries(delivery_type,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escrow_attempts_payer ON escrow_payment_attempts(order_id,payer_role,status);

-- v1.2 does not permit a receiver to be charged for a sender's protection reserve.
-- The reserve belongs only to sender-funded orders.
UPDATE deliveries
SET sender_deposit_amount_minor = CASE
  WHEN payment_mode='RECEIVER_ESCROW' THEN COALESCE(sender_deposit_amount_minor,0)
  ELSE COALESCE(sender_deposit_amount_minor,0)
END;
