ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS declared_value_minor BIGINT;

DO $swiftdrop$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'deliveries_declared_value_positive'
       AND conrelid = 'deliveries'::regclass
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_declared_value_positive
      CHECK (declared_value_minor IS NOT NULL AND declared_value_minor > 0);
  END IF;
END $swiftdrop$;

CREATE INDEX IF NOT EXISTS idx_deliveries_declared_value
  ON deliveries(declared_value_minor);

-- The declared value is the customer's truthful value declaration for carriage/liability.
-- It is not by itself proof of loss and must never authorize a claim above the
-- verified actual loss or the declared value.
