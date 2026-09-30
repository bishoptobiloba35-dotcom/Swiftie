-- Make RETURNED a first-class terminal delivery status for the return-to-sender workflow.
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('CREATED','PAYMENT_AUTHORIZED','DRIVER_ASSIGNED','DRIVER_AT_PICKUP','PICKED_UP','IN_TRANSIT','ARRIVED','DELIVERED','CANCELLED','DISPUTED','RETURNED'))
  NOT VALID;

ALTER TABLE deliveries
  VALIDATE CONSTRAINT deliveries_status_check;

CREATE INDEX IF NOT EXISTS idx_deliveries_returned
  ON deliveries(returned_at DESC)
  WHERE status='RETURNED';
