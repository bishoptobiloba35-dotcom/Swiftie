-- SwiftDrop financial collection modes.
-- Sender-paid orders use the existing held/released escrow-style ledger.
-- Receiver-paid orders do not use escrow: the receiver confirms the parcel first,
-- then pays the exact server-authoritative amount through the payment provider.

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'SENDER_ESCROW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deliveries_payment_mode_check'
      AND conrelid = 'deliveries'::regclass
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_payment_mode_check
      CHECK (payment_mode IN ('SENDER_ESCROW','RECEIVER_ON_DELIVERY'));
  END IF;
END $$;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS collection_mode TEXT NOT NULL DEFAULT 'SENDER_ESCROW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payments_collection_mode_check'
      AND conrelid = 'payments'::regclass
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_collection_mode_check
      CHECK (collection_mode IN ('SENDER_ESCROW','RECEIVER_ON_DELIVERY'));
  END IF;
END $$;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_escrow_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_escrow_status_check
  CHECK (escrow_status IN ('PENDING','HELD','RELEASED','REFUNDED','NOT_APPLICABLE'));

UPDATE payments
SET collection_mode='SENDER_ESCROW'
WHERE collection_mode IS NULL;

UPDATE payments
SET escrow_status='NOT_APPLICABLE'
WHERE collection_mode='RECEIVER_ON_DELIVERY';

CREATE INDEX IF NOT EXISTS idx_deliveries_payment_mode_status
  ON deliveries(payment_mode, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_collection_mode_status
  ON payments(collection_mode, status, updated_at DESC);
