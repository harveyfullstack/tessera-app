-- Attempt start time for the 5-minute stuck derivation. TESSERA-1880
-- deferred this column; display status needs it independently of created_at.
ALTER TABLE delivery_attempts
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
