-- First-class delivery exception workflow: failed attempts, rescheduling and return-to-sender.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES drivers(id),
  attempt_number INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('FAILED','SUCCESSFUL')),
  reason TEXT NOT NULL CHECK (reason IN ('RECIPIENT_UNAVAILABLE','WRONG_ADDRESS','RECIPIENT_REFUSED','ACCESS_BLOCKED','SAFETY_ISSUE','VEHICLE_ISSUE','WEATHER','OTHER')),
  notes TEXT,
  evidence_key TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(delivery_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery_time
  ON delivery_attempts(delivery_id, created_at DESC);

ALTER TABLE deliveries
  ADD COLUMN IF NOT EXISTS exception_status TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS next_delivery_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_reason TEXT,
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

DO $swiftdrop$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'deliveries_exception_status_check'
       AND conrelid = 'deliveries'::regclass
  ) THEN
    ALTER TABLE deliveries
      ADD CONSTRAINT deliveries_exception_status_check
      CHECK (exception_status IN ('NONE','FAILED_ATTEMPT','RESCHEDULED','RETURN_REQUESTED','RETURN_IN_TRANSIT','RETURNED'));
  END IF;
END $swiftdrop$;

CREATE INDEX IF NOT EXISTS idx_deliveries_exception_status
  ON deliveries(exception_status, next_delivery_at);

CREATE TABLE IF NOT EXISTS delivery_exception_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_exception_events_delivery_time
  ON delivery_exception_events(delivery_id, created_at ASC);
