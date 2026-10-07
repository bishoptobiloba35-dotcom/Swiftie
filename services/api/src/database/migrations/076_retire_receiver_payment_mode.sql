-- Retire the legacy receiver-payment/cash collection mode at the database boundary.
-- Existing historical rows were normalized by migration 065; enforce the product rule
-- so no new or direct database write can recreate RECEIVER_ON_DELIVERY.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_payment_mode_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_collection_mode_check;

UPDATE deliveries
SET payment_mode = 'SENDER_ESCROW'
WHERE payment_mode = 'RECEIVER_ON_DELIVERY';

UPDATE payments
SET collection_mode = 'SENDER_ESCROW',
    escrow_status = CASE WHEN escrow_status IS NULL THEN 'PENDING' ELSE escrow_status END
WHERE collection_mode = 'RECEIVER_ON_DELIVERY';

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_payment_mode_check
  CHECK (payment_mode = 'SENDER_ESCROW');

ALTER TABLE payments
  ADD CONSTRAINT payments_collection_mode_check
  CHECK (collection_mode = 'SENDER_ESCROW');
