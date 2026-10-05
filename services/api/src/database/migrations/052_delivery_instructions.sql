ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS pickup_instructions TEXT,
  ADD COLUMN IF NOT EXISTS dropoff_instructions TEXT;

ALTER TABLE deliveries
  DROP CONSTRAINT IF EXISTS deliveries_pickup_instructions_length_check,
  DROP CONSTRAINT IF EXISTS deliveries_dropoff_instructions_length_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_pickup_instructions_length_check CHECK (pickup_instructions IS NULL OR char_length(pickup_instructions) <= 1000),
  ADD CONSTRAINT deliveries_dropoff_instructions_length_check CHECK (dropoff_instructions IS NULL OR char_length(dropoff_instructions) <= 1000);
