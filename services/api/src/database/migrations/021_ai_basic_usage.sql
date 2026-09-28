CREATE TABLE IF NOT EXISTS ai_usage (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  chat_credits_used INTEGER NOT NULL DEFAULT 0 CHECK (chat_credits_used >= 0),
  action_credits_used INTEGER NOT NULL DEFAULT 0 CHECK (action_credits_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_period ON ai_usage(period_start);