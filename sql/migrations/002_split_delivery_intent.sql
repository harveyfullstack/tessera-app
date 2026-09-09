-- Phase-2 cutover: rename mutable jobs intent rows to immutable delivery_jobs,
-- enforce one intent row per (account_id, brief_id, type), and add append-only
-- delivery_attempts. Existing intent rows are migrated without loss or
-- duplication. Attempt-count parity is asserted before the transaction commits.

BEGIN;

-- Oldest row in each intent key is the canonical delivery_jobs survivor.
CREATE TEMP TABLE canonical_jobs AS
SELECT DISTINCT ON (account_id, brief_id, type)
  id
FROM jobs
ORDER BY account_id, brief_id, type, created_at ASC, id ASC;

CREATE TEMP TABLE job_canonical_map AS
SELECT
  j.id AS source_id,
  c.id AS canonical_id,
  j.status,
  j.worker_id,
  j.retry_count,
  j.error_message,
  j.started_at,
  j.completed_at,
  j.created_at
FROM jobs j
JOIN canonical_jobs c
  ON c.id = (
    SELECT id
    FROM jobs d
    WHERE d.account_id = j.account_id
      AND d.brief_id = j.brief_id
      AND d.type = j.type
    ORDER BY d.created_at ASC, d.id ASC
    LIMIT 1
  );

ALTER TABLE jobs RENAME TO delivery_jobs;
ALTER INDEX IF EXISTS jobs_account_brief_idx RENAME TO delivery_jobs_account_brief_idx;
ALTER INDEX IF EXISTS jobs_status_idx RENAME TO delivery_jobs_status_idx;

-- FK uses the default NO ACTION so deleting a delivery_jobs row cannot take history.
CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_job_attempt_key UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Remap parent pointers off duplicate intent rows before those rows are removed.
UPDATE delivery_jobs child
SET parent_job_id = map.canonical_id
FROM job_canonical_map map
WHERE child.parent_job_id = map.source_id
  AND map.source_id <> map.canonical_id;

-- Reconstruct attempt history. Never-started queued rows contribute 0.
-- Every other jobs row contributes GREATEST(retry_count, 1): overwritten
-- retries plus the current execution snapshot on that row.
WITH source_counts AS (
  SELECT
    canonical_id,
    source_id,
    CASE
      WHEN status = 'queued' AND started_at IS NULL AND COALESCE(retry_count, 0) = 0 THEN 0
      ELSE GREATEST(COALESCE(retry_count, 0), 1)
    END AS attempt_count,
    status,
    worker_id,
    error_message,
    started_at,
    completed_at,
    created_at
  FROM job_canonical_map
),
numbered AS (
  SELECT
    *,
    COALESCE(
      SUM(attempt_count) OVER (
        PARTITION BY canonical_id
        ORDER BY created_at, source_id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS attempt_offset
  FROM source_counts
),
expanded AS (
  SELECT
    canonical_id,
    attempt_offset + g AS attempt_number,
    CASE WHEN g = attempt_count THEN worker_id ELSE NULL END AS worker_id,
    CASE WHEN g = attempt_count THEN status ELSE 'failed' END AS status,
    CASE
      WHEN g = attempt_count THEN error_message
      ELSE 'overwritten by retry before delivery_attempts cutover'
    END AS error_body,
    CASE WHEN g = attempt_count THEN started_at ELSE NULL END AS started_at,
    CASE WHEN g = attempt_count THEN completed_at ELSE NULL END AS completed_at
  FROM numbered
  CROSS JOIN LATERAL generate_series(1, attempt_count) AS g
)
INSERT INTO delivery_attempts (
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  completed_at
)
SELECT
  canonical_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  completed_at
FROM expanded;

-- Per-job and aggregate attempt-count parity must hold before cutover.
DO $$
DECLARE
  mismatched_jobs INTEGER;
  old_total BIGINT;
  new_total BIGINT;
BEGIN
  SELECT COUNT(*) INTO mismatched_jobs
  FROM (
    SELECT
      m.canonical_id,
      SUM(
        CASE
          WHEN m.status = 'queued' AND m.started_at IS NULL AND COALESCE(m.retry_count, 0) = 0 THEN 0
          ELSE GREATEST(COALESCE(m.retry_count, 0), 1)
        END
      ) AS old_count
    FROM job_canonical_map m
    GROUP BY m.canonical_id
  ) old_by_job
  FULL OUTER JOIN (
    SELECT delivery_job_id, COUNT(*)::BIGINT AS new_count
    FROM delivery_attempts
    GROUP BY delivery_job_id
  ) new_by_job ON new_by_job.delivery_job_id = old_by_job.canonical_id
  WHERE COALESCE(old_by_job.old_count, 0) <> COALESCE(new_by_job.new_count, 0)
    AND COALESCE(old_by_job.old_count, 0) > 0;

  SELECT COALESCE(SUM(
    CASE
      WHEN status = 'queued' AND started_at IS NULL AND COALESCE(retry_count, 0) = 0 THEN 0
      ELSE GREATEST(COALESCE(retry_count, 0), 1)
    END
  ), 0)
  INTO old_total
  FROM job_canonical_map;

  SELECT COUNT(*) INTO new_total FROM delivery_attempts;

  IF mismatched_jobs > 0 OR old_total <> new_total THEN
    RAISE EXCEPTION
      'delivery attempt-count parity failed (mismatched_jobs=%, old_total=%, new_total=%)',
      mismatched_jobs, old_total, new_total;
  END IF;
END $$;

DELETE FROM delivery_jobs
WHERE id NOT IN (SELECT id FROM canonical_jobs);

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_account_brief_type_key
  UNIQUE (account_id, brief_id, type);

COMMIT;
