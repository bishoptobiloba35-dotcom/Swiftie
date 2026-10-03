-- Drop-off partner earnings are fixed at NGN 500 per accepted parcel/order.
-- The intake route reads commission_minor from drop_off_locations, so the source
-- configuration must be constrained to the same fixed amount as the ledger.

UPDATE drop_off_locations
   SET commission_minor = 50000
 WHERE commission_minor IS DISTINCT FROM 50000;

ALTER TABLE drop_off_locations
  ALTER COLUMN commission_minor SET DEFAULT 50000;

ALTER TABLE drop_off_locations
  DROP CONSTRAINT IF EXISTS drop_off_location_fixed_commission_check;

ALTER TABLE drop_off_locations
  ADD CONSTRAINT drop_off_location_fixed_commission_check
  CHECK (commission_minor = 50000);

COMMENT ON COLUMN drop_off_locations.commission_minor IS
  'Fixed drop-off partner earning: NGN 500 (50000 minor units) per accepted parcel/order.';
