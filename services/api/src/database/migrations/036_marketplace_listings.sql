-- SwiftDrop seller-anchored marketplace listings.
CREATE TABLE IF NOT EXISTS marketplace_seller_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  location_label TEXT,
  avatar_storage_key TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_profile_id UUID NOT NULL REFERENCES marketplace_seller_profiles(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  price_minor BIGINT NOT NULL CHECK (price_minor > 0),
  delivery_fee_minor BIGINT NOT NULL CHECK (delivery_fee_minor >= 0),
  final_price_minor BIGINT NOT NULL CHECK (final_price_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('SAME_STATE','INTER_STATE','EXPRESS','PICKUP')),
  stock_quantity INTEGER NOT NULL DEFAULT 1 CHECK (stock_quantity >= 0),
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','PAUSED','SOLD_OUT','ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (final_price_minor = price_minor + delivery_fee_minor)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_status_created
  ON marketplace_listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller
  ON marketplace_listings(seller_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_category
  ON marketplace_listings(category, status, created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_listing_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listing_media_listing
  ON marketplace_listing_media(listing_id, sort_order);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES marketplace_listings(id) ON DELETE RESTRICT,
  buyer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_final_price_minor BIGINT NOT NULL CHECK (unit_final_price_minor > 0),
  total_minor BIGINT NOT NULL CHECK (total_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
    CHECK (status IN ('PENDING_PAYMENT','PAID','PROCESSING','IN_TRANSIT','DELIVERED','CANCELLED','DISPUTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_buyer
  ON marketplace_orders(buyer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_seller
  ON marketplace_orders(seller_user_id, created_at DESC);
