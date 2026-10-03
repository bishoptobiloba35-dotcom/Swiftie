-- Marketplace listing disclosure fields: condition, intended use, and optional usage instructions.
-- Sellers must accurately describe the state and intended use of goods so buyers can make an informed decision.
ALTER TABLE marketplace_listings
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS use_description TEXT,
  ADD COLUMN IF NOT EXISTS usage_instructions TEXT;

ALTER TABLE marketplace_listings
  DROP CONSTRAINT IF EXISTS marketplace_listings_condition_check;

ALTER TABLE marketplace_listings
  ADD CONSTRAINT marketplace_listings_condition_check
  CHECK (condition IN ('NEW','LIKE_NEW','GOOD','FAIR','USED','FOR_PARTS'));

ALTER TABLE marketplace_listings
  ADD CONSTRAINT marketplace_listings_use_description_check
  CHECK (use_description IS NOT NULL AND length(btrim(use_description)) BETWEEN 5 AND 2000);

ALTER TABLE marketplace_listings
  ADD CONSTRAINT marketplace_listings_usage_instructions_check
  CHECK (usage_instructions IS NULL OR length(btrim(usage_instructions)) <= 5000);

COMMENT ON COLUMN marketplace_listings.condition IS
  'Seller-declared physical condition: NEW, LIKE_NEW, GOOD, FAIR, USED, or FOR_PARTS.';

COMMENT ON COLUMN marketplace_listings.use_description IS
  'What the product is for and its intended everyday use.';

COMMENT ON COLUMN marketplace_listings.usage_instructions IS
  'Optional instructions or illustrated-use guidance. Sellers can use listing media for visual demonstrations.';
