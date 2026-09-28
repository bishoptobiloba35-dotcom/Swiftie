ALTER TABLE business_ai_rules
  ADD COLUMN IF NOT EXISTS daily_spend_used_minor INTEGER NOT NULL DEFAULT 0 CHECK (daily_spend_used_minor >= 0),
  ADD COLUMN IF NOT EXISTS daily_spend_date DATE NOT NULL DEFAULT CURRENT_DATE;

UPDATE business_ai_rules
SET daily_spend_used_minor=0, daily_spend_date=CURRENT_DATE
WHERE daily_spend_date IS NULL;