CREATE TABLE IF NOT EXISTS legal_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  acceptable_use_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address INET,
  user_agent TEXT,
  UNIQUE(user_id, terms_version, privacy_version, acceptable_use_version)
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user_time
  ON legal_acceptances(user_id, accepted_at DESC);
