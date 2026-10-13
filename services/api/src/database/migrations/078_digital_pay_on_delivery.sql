-- Digital Pay-on-Delivery (POD) — server-verified, zero cash handling.
-- Cash collection remains impossible at the database boundary.
-- Client never marks payment complete; only Paystack webhook can move
-- an order from RECEIVER_PAYMENT_PENDING -> PAYMENT_VERIFIED.

-- 1. Expand allowed payment modes
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_payment_mode_check;
ALTER TABLE payments   DROP CONSTRAINT IF EXISTS payments_collection_mode_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_payment_mode_check
  CHECK (payment_mode IN (
    'SENDER_ESCROW',
    'RECEIVER_ESCROW',
    'PAY_ON_DELIVERY',
    'RECEIVER_ON_DELIVERY' -- legacy-only label; API never permits new cash orders
  ));

ALTER TABLE payments
  ADD CONSTRAINT payments_collection_mode_check
  CHECK (collection_mode IN (
    'SENDER_ESCROW',
    'RECEIVER_ESCROW',
    'PAY_ON_DELIVERY'
  ));

-- 2. Expand allowed delivery statuses for the POD lifecycle
-- Previous constraint (migration 029) did not include POD states.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check
  CHECK (status IN (
    'CREATED',
    'PAYMENT_PENDING',
    'PAYMENT_AUTHORIZED',
    'DRIVER_ASSIGNED',
    'DRIVER_AT_PICKUP',
    'PICKED_UP',
    'IN_TRANSIT',
    'ARRIVED',
    'RECEIVER_PAYMENT_PENDING',
    'PAYMENT_VERIFIED',
    'HANDED_OVER',
    'PIN_CONFIRMED',
    'DELIVERED',
    'DISPUTE_WINDOW',
    'RELEASED',
    'CANCELLED',
    'DISPUTED',
    'RETURNED'
  ));

-- 3. Track when digital POD was verified by webhook
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pod_verified_at TIMESTAMPTZ;

-- 4. Explicit pending-payment flag for the receiver (server-controlled)
ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS receiver_payment_pending BOOLEAN NOT NULL DEFAULT false;

-- 5. Index for operational queries
CREATE INDEX IF NOT EXISTS idx_deliveries_pod_pending
  ON deliveries (status, payment_mode, receiver_payment_pending)
  WHERE payment_mode = 'PAY_ON_DELIVERY' AND receiver_payment_pending = true;

COMMENT ON COLUMN deliveries.payment_mode IS
  'SENDER_ESCROW | RECEIVER_ESCROW | PAY_ON_DELIVERY (digital only). RECEIVER_ON_DELIVERY is retained only for legacy historical rows; new cash orders are forbidden.';
COMMENT ON COLUMN deliveries.pod_verified_at IS
  'Set only by verified Paystack webhook when PAY_ON_DELIVERY payment succeeds.';
COMMENT ON COLUMN deliveries.receiver_payment_pending IS
  'Server-controlled. True while order is ARRIVED and awaiting digital payment from receiver.';
