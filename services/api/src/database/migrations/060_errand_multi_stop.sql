-- Multi-stop errand execution, inspired by multi-stop delivery/task workflows.
CREATE TABLE IF NOT EXISTS buy_order_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buy_order_id UUID NOT NULL REFERENCES buy_orders(id) ON DELETE CASCADE,
  stop_order INTEGER NOT NULL CHECK (stop_order BETWEEN 1 AND 10),
  stop_type TEXT NOT NULL DEFAULT 'TASK' CHECK (stop_type IN ('TASK','PICKUP','PURCHASE','INSPECT','DROP_OFF')),
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  instructions TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','SKIPPED')),
  completed_at TIMESTAMPTZ,
  completed_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(buy_order_id, stop_order)
);
CREATE INDEX IF NOT EXISTS idx_buy_order_stops_order ON buy_order_stops(buy_order_id, stop_order);
