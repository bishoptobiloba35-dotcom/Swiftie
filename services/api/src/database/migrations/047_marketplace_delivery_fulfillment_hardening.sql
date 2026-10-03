-- Marketplace fulfillment hardening: keep fulfillment scheduling indexed and
-- make delivery linkage auditable without changing existing order status semantics.
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_delivery_status
  ON marketplace_orders(delivery_id, fulfillment_status)
  WHERE delivery_id IS NOT NULL;

COMMENT ON COLUMN marketplace_orders.delivery_id IS
  'Linked SwiftDrop delivery created for a paid marketplace order; the marketplace payment remains authoritative.';

COMMENT ON COLUMN marketplace_orders.fulfillment_status IS
  'Fulfillment lifecycle independent of marketplace payment state: NOT_STARTED, READY, IN_PROGRESS, FULFILLED, or CANCELLED.';
