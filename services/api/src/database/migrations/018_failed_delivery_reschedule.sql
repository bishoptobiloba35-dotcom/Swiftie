CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('RECEIVER_UNAVAILABLE','ACCESS_BLOCKED','ADDRESS_ISSUE','REFUSED','OTHER')),
  notes TEXT,
  contact_attempted BOOLEAN NOT NULL DEFAULT false,
  wait_minutes INTEGER NOT NULL DEFAULT 0 CHECK (wait_minutes >= 0 AND wait_minutes <= 240),
  action TEXT NOT NULL CHECK (action IN ('RESCHEDULE','RETURN_TO_SENDER','SUPPORT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery_created
  ON delivery_attempts(delivery_id, created_at DESC);

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS rescheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0);

CREATE INDEX IF NOT EXISTS idx_deliveries_rescheduled_for
  ON deliveries(rescheduled_for)
  WHERE rescheduled_for IS NOT NULL;