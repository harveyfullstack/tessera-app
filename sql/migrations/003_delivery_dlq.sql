BEGIN;
ALTER TABLE delivery_attempts DROP CONSTRAINT delivery_attempts_status_check;
ALTER TABLE delivery_attempts ADD CONSTRAINT delivery_attempts_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'dlq'));
-- The first appended record snapshots the maximum mapped legacy retry count.
-- Later records carry that baseline; failed outcome rows add to it without
-- counting running/retry lifecycle records as extra delivery failures.
ALTER TABLE delivery_attempts ADD COLUMN legacy_retry_count INTEGER NOT NULL DEFAULT 0
  CHECK (legacy_retry_count >= 0);
COMMIT;
