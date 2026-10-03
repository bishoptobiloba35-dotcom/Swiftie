-- SwiftDrop drop-off partner earnings are a fixed NGN 500 per accepted order.
-- This is a partner commission, not a percentage of the customer's delivery price.
-- The ledger remains one-row-per-parcel, so retries cannot create duplicate earnings.

UPDATE drop_off_commission_ledger
   SET amount_minor = 50000
 WHERE amount_minor IS DISTINCT FROM 50000;

ALTER TABLE drop_off_commission_ledger
  ALTER COLUMN amount_minor SET DEFAULT 50000;

ALTER TABLE drop_off_commission_ledger
  DROP CONSTRAINT IF EXISTS drop_off_commission_fixed_amount_check;

ALTER TABLE drop_off_commission_ledger
  ADD CONSTRAINT drop_off_commission_fixed_amount_check
  CHECK (amount_minor = 50000);

COMMENT ON COLUMN drop_off_commission_ledger.amount_minor IS
  'Fixed drop-off partner earning: NGN 500 (50000 minor units) per accepted order/parcel.';

