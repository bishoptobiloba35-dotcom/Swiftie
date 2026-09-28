ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS total_refunded_minor INTEGER NOT NULL DEFAULT 0;

UPDATE payments
SET total_refunded_minor = COALESCE(total_refunded_minor, 0)
WHERE total_refunded_minor IS NULL;
