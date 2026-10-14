-- Phase 2: split immutable delivery intent from append-only execution attempts.
--
-- delivery_jobs holds one immutable intent row per (account_id, brief_id, type).
-- delivery_attempts holds one append-only row per execution attempt.
--
-- jobs is neither renamed nor dropped: the 14-day rollback still reads
-- jobs.status. Every existing jobs row, including legacy duplicate keys, is
-- mapped to its canonical intent through jobs.delivery_job_id.
--
-- Prior attempt bodies were never stored, so delivery_attempts is not
-- backfilled. Attempts are appended from the cutover forward and
-- jobs.retry_count remains the only legacy attempt signal.

BEGIN;

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The uniqueness constraint targets the intent, never the attempt.
  CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type)
);

-- Backfill one canonical intent per key. The earliest jobs row for the key
-- (ties broken by id) is canonical and lends its id, task and metadata.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, type, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id, account_id, brief_id, task_id, type, metadata, created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at, id
ON CONFLICT (account_id, brief_id, type) DO NOTHING;

-- Map every jobs row, duplicates included, to its intent. Nullable so the
-- legacy write path keeps working while the rollback bar is open.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS delivery_job_id UUID
    REFERENCES delivery_jobs(id) ON DELETE RESTRICT;

UPDATE jobs
SET delivery_job_id = delivery_jobs.id
FROM delivery_jobs
WHERE jobs.delivery_job_id IS NULL
  AND delivery_jobs.account_id = jobs.account_id
  AND delivery_jobs.brief_id = jobs.brief_id
  AND delivery_jobs.type = jobs.type;

CREATE INDEX IF NOT EXISTS jobs_delivery_job_idx ON jobs (delivery_job_id);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  -- No CASCADE: deleting an intent must never take its history with it.
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INTEGER,
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,

  CONSTRAINT delivery_attempts_job_attempt_key UNIQUE (delivery_job_id, attempt_number)
);

-- Latest-attempt reads: ORDER BY attempt_number DESC LIMIT 1 per job.
CREATE INDEX IF NOT EXISTS delivery_attempts_job_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Intent rows are immutable; attempt rows are append-only.
CREATE OR REPLACE FUNCTION reject_delivery_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: rows are immutable', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS delivery_jobs_immutable ON delivery_jobs;
CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

DROP TRIGGER IF EXISTS delivery_attempts_append_only ON delivery_attempts;
CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

COMMIT;
