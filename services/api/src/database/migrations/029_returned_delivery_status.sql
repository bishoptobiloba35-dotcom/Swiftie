-- Make RETURNED a first-class terminal delivery status for the return-to-sender workflow.
DO $swiftdrop$
DECLARE
  existing_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO existing_definition
    FROM pg_constraint c
   WHERE c.conname = 'deliveries_status_check'
     AND c.conrelid = 'deliveries'::regclass;

  IF existing_definition IS NULL THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_status_check
      CHECK (status IN ('CREATED','PAYMENT_AUTHORIZED','DRIVER_ASSIGNED','DRIVER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED','CANCELLED','DISPUTED','RETURNED'))
      NOT VALID;
  ELSIF position('RETURNED' IN existing_definition) = 0 THEN
    ALTER TABLE deliveries DROP CONSTRAINT deliveries_status_check;
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_status_check
      CHECK (status IN ('CREATED','PAYMENT_AUTHORIZED','DRIVER_ASSIGNED','DRIVER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED','CANCELLED','DISPUTED','RETURNED'))
      NOT VALID;
  END IF;
END
$swiftdrop$;

ALTER TABLE deliveries
  VALIDATE CONSTRAINT deliveries_status_check;

CREATE INDEX IF NOT EXISTS idx_deliveries_returned
  ON deliveries(returned_at DESC)
  WHERE status='RETURNED';
