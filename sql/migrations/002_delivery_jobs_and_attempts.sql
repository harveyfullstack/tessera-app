-- Phase-2 schema split: immutable delivery intent vs append-only attempts.
-- The pre-migration jobs table is retained for the 14-day rollback bar.

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  -- Remapped after intent rows are inserted so collapsed duplicates cannot
  -- break the self-FK during backfill.
  parent_job_id UUID REFERENCES delivery_jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Intent uniqueness: one delivery job per account/brief/type.
  -- Retries append attempts; they must not create a second intent row.
  CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type)
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  -- Explicitly no ON DELETE CASCADE: deleting a delivery_jobs row must not
  -- take attempt history with it (PostgreSQL default is NO ACTION).
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_job_number_key UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_job_number_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Collapse duplicate pre-split intent rows onto the earliest jobs.id.
INSERT INTO delivery_jobs (
  id,
  account_id,
  brief_id,
  task_id,
  parent_job_id,
  type,
  metadata,
  created_at
)
SELECT DISTINCT ON (account_id, brief_id, type)
  id,
  account_id,
  brief_id,
  task_id,
  NULL,
  type,
  metadata,
  created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at ASC, id ASC
ON CONFLICT (id) DO NOTHING;

-- Reconstruct attempt history from each pre-split jobs row, remapped onto the
-- canonical delivery_jobs id for the (account_id, brief_id, type) key.
WITH canonical AS (
  SELECT DISTINCT ON (account_id, brief_id, type)
    id AS delivery_job_id,
    account_id,
    brief_id,
    type
  FROM jobs
  ORDER BY account_id, brief_id, type, created_at ASC, id ASC
),
source AS (
  SELECT
    j.id AS source_job_id,
    c.delivery_job_id,
    j.status,
    j.worker_id,
    j.retry_count,
    j.error_message,
    j.started_at,
    j.created_at,
    CASE
      WHEN j.status = 'queued' AND j.retry_count = 0 AND j.started_at IS NULL THEN 0
      ELSE j.retry_count + 1
    END AS old_attempt_count
  FROM jobs j
  JOIN canonical c
    ON c.account_id = j.account_id
   AND c.brief_id = j.brief_id
   AND c.type = j.type
),
expanded AS (
  SELECT
    s.delivery_job_id,
    s.source_job_id,
    s.created_at,
    gs.attempt_ordinal,
    s.old_attempt_count,
    CASE
      WHEN gs.attempt_ordinal < s.old_attempt_count THEN 'failed'
      ELSE s.status
    END AS status,
    CASE
      WHEN gs.attempt_ordinal < s.old_attempt_count THEN NULL
      ELSE s.worker_id
    END AS worker_id,
    CASE
      WHEN gs.attempt_ordinal < s.old_attempt_count
        THEN 'reconstructed pre-split retry; original attempt body was overwritten'
      ELSE s.error_message
    END AS error_body,
    CASE
      WHEN gs.attempt_ordinal < s.old_attempt_count THEN NULL
      ELSE s.started_at
    END AS started_at
  FROM source s
  JOIN LATERAL generate_series(1, s.old_attempt_count) AS gs(attempt_ordinal) ON TRUE
),
numbered AS (
  SELECT
    gen_random_uuid() AS id,
    delivery_job_id,
    row_number() OVER (
      PARTITION BY delivery_job_id
      ORDER BY created_at ASC, source_job_id ASC, attempt_ordinal ASC
    ) AS attempt_number,
    worker_id,
    status,
    error_body,
    started_at
  FROM expanded
)
INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at
)
SELECT
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at
FROM numbered
ON CONFLICT (delivery_job_id, attempt_number) DO NOTHING;

-- Cutover gate: old/new attempt-count parity per delivery job and in aggregate.
-- The following query must return zero rows before the split is enabled.
--
-- WITH canonical AS (
--   SELECT DISTINCT ON (account_id, brief_id, type)
--     id AS delivery_job_id, account_id, brief_id, type
--   FROM jobs
--   ORDER BY account_id, brief_id, type, created_at ASC, id ASC
-- ),
-- old_counts AS (
--   SELECT
--     c.delivery_job_id,
--     SUM(
--       CASE
--         WHEN j.status = 'queued' AND j.retry_count = 0 AND j.started_at IS NULL THEN 0
--         ELSE j.retry_count + 1
--       END
--     ) AS old_count
--   FROM jobs j
--   JOIN canonical c
--     ON c.account_id = j.account_id
--    AND c.brief_id = j.brief_id
--    AND c.type = j.type
--   GROUP BY c.delivery_job_id
-- ),
-- new_counts AS (
--   SELECT delivery_job_id, COUNT(*)::int AS new_count
--   FROM delivery_attempts
--   GROUP BY delivery_job_id
-- )
-- SELECT
--   COALESCE(o.delivery_job_id, n.delivery_job_id) AS delivery_job_id,
--   COALESCE(o.old_count, 0) AS old_count,
--   COALESCE(n.new_count, 0) AS new_count
-- FROM old_counts o
-- FULL OUTER JOIN new_counts n ON n.delivery_job_id = o.delivery_job_id
-- WHERE COALESCE(o.old_count, 0) IS DISTINCT FROM COALESCE(n.new_count, 0);
