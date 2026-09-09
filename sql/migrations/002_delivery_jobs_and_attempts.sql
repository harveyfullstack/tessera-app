-- Phase 2: split immutable delivery intent from append-only attempt history.
-- Migrates existing jobs rows without loss; each legacy row becomes one intent
-- row plus one synthetic attempt when execution state was present.

ALTER TABLE jobs RENAME TO delivery_jobs;

ALTER TABLE delivery_jobs
  DROP CONSTRAINT IF EXISTS jobs_parent_job_id_fkey;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_parent_job_id_fkey
  FOREIGN KEY (parent_job_id) REFERENCES delivery_jobs(id);

-- Intent uniqueness: one delivery job per (account, brief, type).
CREATE UNIQUE INDEX IF NOT EXISTS delivery_jobs_account_brief_type_uidx
  ON delivery_jobs (account_id, brief_id, type);

DROP INDEX IF EXISTS jobs_account_brief_idx;
CREATE INDEX IF NOT EXISTS delivery_jobs_account_brief_idx
  ON delivery_jobs (account_id, brief_id);

DROP INDEX IF EXISTS jobs_status_idx;
CREATE INDEX IF NOT EXISTS delivery_jobs_status_idx ON delivery_jobs (status);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_attempts_job_attempt_uidx
    UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Backfill one attempt per legacy row that had left the queued state.
INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  response_status,
  error_body,
  started_at,
  completed_at,
  created_at
)
SELECT
  gen_random_uuid(),
  dj.id,
  GREATEST(dj.retry_count, 1),
  dj.worker_id,
  dj.status,
  NULL,
  dj.error_message,
  COALESCE(dj.started_at, dj.updated_at),
  dj.completed_at,
  dj.updated_at
FROM delivery_jobs dj
WHERE dj.status <> 'queued'
ON CONFLICT (delivery_job_id, attempt_number) DO NOTHING;
