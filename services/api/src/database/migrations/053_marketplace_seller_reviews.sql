CREATE TABLE IF NOT EXISTS marketplace_seller_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_seller_reviews_seller
  ON marketplace_seller_reviews(seller_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_seller_reviews_buyer
  ON marketplace_seller_reviews(buyer_user_id, created_at DESC);

ALTER TABLE marketplace_seller_reviews
  DROP CONSTRAINT IF EXISTS marketplace_seller_reviews_comment_length_check;

ALTER TABLE marketplace_seller_reviews
  ADD CONSTRAINT marketplace_seller_reviews_comment_length_check
  CHECK (comment IS NULL OR char_length(comment) <= 1000);
