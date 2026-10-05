-- Harden unified errand shopping authorization with an optional original/requested item price.
ALTER TABLE buy_order_items
  ADD COLUMN IF NOT EXISTS requested_price_minor BIGINT
    CHECK (requested_price_minor IS NULL OR requested_price_minor >= 0);

COMMENT ON COLUMN buy_order_items.requested_price_minor IS
  'Customer-provided original item price used as the baseline for max-price-difference authorization.';