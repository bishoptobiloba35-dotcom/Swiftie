-- Work Order 0 / Item 2: complete escrow payment-attempt attribution and provider idempotency.
-- Keep the historical order_id -> deliveries(id) relationship; the production code uses deliveries.
-- Legacy rows are retained. payer_id is backfilled where the order's payer can be determined.

ALTER TABLE escrow_payment_attempts
  ADD COLUMN IF NOT EXISTS payer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'paystack',
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'NGN';

UPDATE escrow_payment_attempts epa
   SET payer_id = CASE
     WHEN epa.payer_role = 'RECEIVER' THEN d.receiver_user_id
     ELSE d.sender_id
   END
  FROM deliveries d
 WHERE d.id = epa.order_id
   AND epa.payer_id IS NULL;

-- Do not silently delete or rewrite financial records to make this index possible.
-- Abort the migration if legacy data already contains conflicting provider references.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM escrow_payment_attempts
     WHERE provider_reference IS NOT NULL
     GROUP BY provider, provider_reference
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add escrow payment provider-reference uniqueness: duplicate (provider, provider_reference) values exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS escrow_payment_attempts_provider_reference_unique
  ON escrow_payment_attempts(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_escrow_payment_attempts_order
  ON escrow_payment_attempts(order_id);

-- Existing constraints from migrations 065/077 remain authoritative:
-- positive amount, supported method/status, payer role, collection channel, and unique idempotency_key.
