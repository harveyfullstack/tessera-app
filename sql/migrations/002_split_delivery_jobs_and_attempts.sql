-- Phase 2 schema split: immutable delivery intent (delivery_jobs) beside
-- append-only execution history (delivery_attempts).
--
-- The legacy jobs table is kept as-is: the 14-day rollback still reads
-- jobs.status, so it is neither renamed nor dropped. Every jobs row is
-- mapped to its canonical intent through jobs.delivery_job_id.
--
-- Prior attempt bodies were never stored, so delivery_attempts is appended
-- from the cutover forward only; jobs.retry_count remains the only legacy
-- attempt signal.

BEGIN;

-- Immutable delivery intent: one row per (account_id, brief_id, type).
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_jobs_account_brief_type_key
    UNIQUE (account_id, brief_id, type)
);

-- Backfill one canonical intent per key. The earliest jobs row (ties broken
-- by id) is canonical and lends its id, so the mapping is deterministic.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, type, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id, account_id, brief_id, task_id, type, metadata, created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at, id
ON CONFLICT (account_id, brief_id, type) DO NOTHING;

-- Map every jobs row, duplicate keys included, to its canonical intent.
-- Uniqueness is enforced on delivery_jobs only; jobs keeps its duplicates.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS delivery_job_id UUID REFERENCES delivery_jobs(id);

UPDATE jobs
SET delivery_job_id = delivery_jobs.id
FROM delivery_jobs
WHERE jobs.delivery_job_id IS NULL
  AND delivery_jobs.account_id = jobs.account_id
  AND delivery_jobs.brief_id = jobs.brief_id
  AND delivery_jobs.type = jobs.type;

CREATE INDEX IF NOT EXISTS jobs_delivery_job_idx ON jobs (delivery_job_id);

-- Append-only execution history. The FK deliberately has no ON DELETE
-- CASCADE: deleting a delivery_jobs row must never take its history with it.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  worker_id TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INTEGER,
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT
);

-- One index both enforces uniqueness on (delivery_job_id, attempt_number)
-- and serves latest-attempt reads in descending attempt order.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_attempts_job_attempt_desc_key
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Intent rows are immutable; attempt rows are append-only.
CREATE OR REPLACE FUNCTION reject_delivery_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS delivery_jobs_immutable ON delivery_jobs;
CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

DROP TRIGGER IF EXISTS delivery_attempts_append_only ON delivery_attempts;
CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

COMMIT;
