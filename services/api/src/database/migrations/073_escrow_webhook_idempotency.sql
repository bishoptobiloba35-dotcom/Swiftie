-- Prevent duplicate escrow funding float entries when a Paystack webhook is replayed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_float_transactions_type_provider_reference
  ON float_transactions(type, provider_reference)
  WHERE provider_reference IS NOT NULL;
