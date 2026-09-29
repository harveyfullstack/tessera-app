-- Phase 2 schema split: immutable delivery intent (delivery_jobs) beside the
-- existing jobs table, plus append-only execution history (delivery_attempts).
--
-- jobs is intentionally NOT renamed or dropped: the 14-day rollback still reads
-- jobs.status. The only change to jobs is an additive, nullable mapping column.
--
-- Prior attempt bodies were never stored, so no delivery_attempts rows are
-- backfilled. Attempts are appended from the cutover forward, and
-- jobs.retry_count remains the only legacy attempt signal.

BEGIN;

-- Immutable intent. Uniqueness on (account_id, brief_id, type) lives here only;
-- jobs keeps its duplicate rows.
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_jobs_intent_key UNIQUE (account_id, brief_id, type)
);

CREATE OR REPLACE FUNCTION delivery_jobs_reject_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'delivery_jobs rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS delivery_jobs_immutable ON delivery_jobs;
CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION delivery_jobs_reject_update();

-- Append-only execution history. No ON DELETE CASCADE: deleting a
-- delivery_jobs row must never take its attempt history with it.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL
    REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INTEGER,
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,

  CONSTRAINT delivery_attempts_job_attempt_key
    UNIQUE (delivery_job_id, attempt_number)
);

-- Latest-attempt reads: ORDER BY attempt_number DESC LIMIT 1 per job.
CREATE INDEX IF NOT EXISTS delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

CREATE OR REPLACE FUNCTION delivery_attempts_reject_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'delivery_attempts is append-only (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS delivery_attempts_append_only ON delivery_attempts;
CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION delivery_attempts_reject_mutation();

-- Map every jobs row, duplicates included, to its one canonical intent.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS delivery_job_id UUID REFERENCES delivery_jobs(id);

CREATE INDEX IF NOT EXISTS jobs_delivery_job_idx ON jobs (delivery_job_id);

-- Backfill one canonical intent per (account_id, brief_id, type). The earliest
-- jobs row (created_at, then id as tie-break) is canonical, and its id is
-- reused as the delivery_jobs id so the intent traces back to its origin row.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, type, metadata, created_at)
SELECT DISTINCT ON (j.account_id, j.brief_id, j.type)
  j.id, j.account_id, j.brief_id, j.task_id, j.type, j.metadata, j.created_at
FROM jobs j
ORDER BY j.account_id, j.brief_id, j.type, j.created_at, j.id
ON CONFLICT (account_id, brief_id, type) DO NOTHING;

UPDATE jobs j
SET delivery_job_id = dj.id
FROM delivery_jobs dj
WHERE dj.account_id = j.account_id
  AND dj.brief_id = j.brief_id
  AND dj.type = j.type
  AND j.delivery_job_id IS NULL;

COMMIT;
