ALTER TABLE ai_permissions
  ADD COLUMN IF NOT EXISTS daily_spend_date DATE NOT NULL DEFAULT CURRENT_DATE;

UPDATE ai_permissions
SET daily_spend_date = CURRENT_DATE
WHERE daily_spend_date IS NULL;
