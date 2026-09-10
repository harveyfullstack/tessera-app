-- Phase 2: split immutable delivery intent from append-only attempt history.
-- Duplicate intents are archived before the uniqueness index is created.
-- The delivery_attempts FK is RESTRICT so deleting a delivery_jobs row
-- cannot take history with it.

ALTER TABLE jobs RENAME TO delivery_jobs;

ALTER TABLE delivery_jobs
  DROP CONSTRAINT IF EXISTS jobs_parent_job_id_fkey;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_parent_job_id_fkey
  FOREIGN KEY (parent_job_id) REFERENCES delivery_jobs(id);

CREATE TABLE IF NOT EXISTS delivery_jobs_duplicate_intents (
  id UUID PRIMARY KEY,
  canonical_delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  worker_id TEXT,
  retry_count INTEGER NOT NULL,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH ranked AS (
  SELECT
    id,
    account_id,
    brief_id,
    type,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, brief_id, type
      ORDER BY updated_at DESC, created_at ASC, id ASC
    ) AS row_number,
    FIRST_VALUE(id) OVER (
      PARTITION BY account_id, brief_id, type
      ORDER BY updated_at DESC, created_at ASC, id ASC
    ) AS canonical_id
  FROM delivery_jobs
)
INSERT INTO delivery_jobs_duplicate_intents (
  id,
  canonical_delivery_job_id,
  account_id,
  brief_id,
  task_id,
  parent_job_id,
  type,
  metadata,
  status,
  worker_id,
  retry_count,
  error_message,
  started_at,
  completed_at,
  created_at,
  updated_at
)
SELECT
  dj.id,
  ranked.canonical_id,
  dj.account_id,
  dj.brief_id,
  dj.task_id,
  dj.parent_job_id,
  dj.type,
  dj.metadata,
  dj.status,
  dj.worker_id,
  dj.retry_count,
  dj.error_message,
  dj.started_at,
  dj.completed_at,
  dj.created_at,
  dj.updated_at
FROM delivery_jobs dj
JOIN ranked ON ranked.id = dj.id
WHERE ranked.row_number > 1;

DELETE FROM delivery_jobs dj
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, brief_id, type
      ORDER BY updated_at DESC, created_at ASC, id ASC
    ) AS row_number
  FROM delivery_jobs
) ranked
WHERE dj.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX delivery_jobs_account_brief_type_uidx
  ON delivery_jobs (account_id, brief_id, type);

DROP INDEX IF EXISTS jobs_account_brief_idx;
CREATE INDEX delivery_jobs_account_brief_idx
  ON delivery_jobs (account_id, brief_id);

DROP INDEX IF EXISTS jobs_status_idx;
CREATE INDEX delivery_jobs_status_idx ON delivery_jobs (status);

CREATE TABLE delivery_attempts (
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

CREATE INDEX delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

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
  series.attempt_number,
  CASE
    WHEN series.attempt_number = terminal_counts.terminal_count THEN dj.worker_id
    ELSE NULL
  END,
  CASE
    WHEN dj.status = 'completed' AND series.attempt_number = terminal_counts.terminal_count THEN 'completed'
    WHEN dj.status = 'running' AND series.attempt_number = terminal_counts.terminal_count THEN 'running'
    WHEN dj.status = 'cancelled' AND series.attempt_number = terminal_counts.terminal_count THEN 'cancelled'
    WHEN dj.status = 'queued' AND series.attempt_number = terminal_counts.terminal_count THEN 'queued'
    ELSE 'failed'
  END,
  NULL,
  CASE
    WHEN series.attempt_number < terminal_counts.terminal_count THEN 'legacy failed execution'
    ELSE dj.error_message
  END,
  COALESCE(dj.started_at, dj.updated_at),
  CASE
    WHEN series.attempt_number = terminal_counts.terminal_count THEN dj.completed_at
    ELSE NULL
  END,
  dj.updated_at
FROM delivery_jobs dj
JOIN LATERAL (
  SELECT
    CASE
      -- Fresh queued: no history at all, zero attempt rows.
      WHEN dj.status = 'queued' AND dj.retry_count = 0 THEN 0
      -- Requeued-with-history: retry_count prior failures + the current
      -- queued row itself (queued is a tracked attempt status).
      WHEN dj.status = 'queued' THEN dj.retry_count + 1
      -- Recovered after retries: retry_count prior failures + the completed row.
      WHEN dj.status = 'completed' THEN dj.retry_count + 1
      -- In-flight or halted mid-retry: retry_count prior failures + the
      -- current running/cancelled row. Must not collapse to retry_count alone.
      WHEN dj.status = 'running' THEN dj.retry_count + 1
      WHEN dj.status = 'cancelled' THEN dj.retry_count + 1
      -- Failed-terminal: legacy retry_count already counts every failed
      -- execution including the current one.
      ELSE GREATEST(dj.retry_count, 1)
    END AS terminal_count
) terminal_counts ON TRUE
JOIN LATERAL generate_series(1, terminal_counts.terminal_count) AS series(attempt_number) ON TRUE
WHERE terminal_counts.terminal_count > 0;
