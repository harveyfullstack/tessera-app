-- Phase 2 schema split: immutable delivery intent + append-only attempts.
-- Renames the mixed jobs table to delivery_jobs, collapses duplicate intent
-- rows onto (account_id, brief_id, type), and backfills delivery_attempts so
-- old/new attempt counts match per job and in aggregate before cutover.

ALTER TABLE IF EXISTS jobs RENAME TO delivery_jobs;

ALTER INDEX IF EXISTS jobs_account_brief_idx RENAME TO delivery_jobs_account_brief_idx;
ALTER INDEX IF EXISTS jobs_status_idx RENAME TO delivery_jobs_status_idx;

-- Append-only history. The FK is intentionally ON DELETE NO ACTION / RESTRICT
-- (Postgres default): deleting a delivery_jobs row must not CASCADE history.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Reconstruct attempt rows from every pre-split jobs row, folding duplicates
-- onto the earliest canonical intent. retry_count + a started/terminal row
-- is the legacy attempt count used for cutover parity.
WITH canonical AS (
  SELECT DISTINCT ON (account_id, brief_id, type)
    id,
    account_id,
    brief_id,
    type
  FROM delivery_jobs
  ORDER BY account_id, brief_id, type, created_at ASC
),
source AS (
  SELECT
    c.id AS delivery_job_id,
    j.id AS source_id,
    j.worker_id,
    j.status,
    j.error_message,
    j.started_at,
    j.updated_at,
    CASE
      WHEN j.started_at IS NULL AND j.status = 'queued' THEN 0
      ELSE j.retry_count + 1
    END AS attempt_count
  FROM delivery_jobs j
  JOIN canonical c
    ON c.account_id = j.account_id
   AND c.brief_id = j.brief_id
   AND c.type = j.type
),
numbered AS (
  SELECT
    source.*,
    COALESCE(
      SUM(attempt_count) OVER (
        PARTITION BY delivery_job_id
        ORDER BY updated_at, source_id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS attempt_offset
  FROM source
)
INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  created_at
)
SELECT
  gen_random_uuid(),
  numbered.delivery_job_id,
  numbered.attempt_offset + gs.n,
  CASE WHEN gs.n = numbered.attempt_count THEN numbered.worker_id END,
  CASE
    WHEN gs.n = numbered.attempt_count THEN numbered.status
    ELSE 'failed'
  END,
  CASE WHEN gs.n = numbered.attempt_count THEN numbered.error_message END,
  CASE WHEN gs.n = numbered.attempt_count THEN numbered.started_at END,
  NOW()
FROM numbered
CROSS JOIN LATERAL generate_series(1, numbered.attempt_count) AS gs(n)
WHERE numbered.attempt_count > 0;

-- Cutover gate: old/new attempt counts must match per canonical job and
-- in aggregate. Fail the migration rather than ship a silent gap.
DO $$
DECLARE
  old_aggregate bigint;
  new_aggregate bigint;
  mismatched bigint;
BEGIN
  SELECT COALESCE(SUM(
    CASE
      WHEN started_at IS NULL AND status = 'queued' THEN 0
      ELSE retry_count + 1
    END
  ), 0)
  INTO old_aggregate
  FROM delivery_jobs;

  SELECT COUNT(*) INTO new_aggregate FROM delivery_attempts;

  IF old_aggregate IS DISTINCT FROM new_aggregate THEN
    RAISE EXCEPTION
      'attempt-count parity failed in aggregate: old=% new=%',
      old_aggregate,
      new_aggregate;
  END IF;

  SELECT COUNT(*) INTO mismatched
  FROM (
    SELECT
      canonical_id,
      SUM(legacy_count) AS old_count,
      (
        SELECT COUNT(*)
        FROM delivery_attempts da
        WHERE da.delivery_job_id = grouped.canonical_id
      ) AS new_count
    FROM (
      SELECT
        c.id AS canonical_id,
        CASE
          WHEN j.started_at IS NULL AND j.status = 'queued' THEN 0
          ELSE j.retry_count + 1
        END AS legacy_count
      FROM delivery_jobs j
      JOIN (
        SELECT DISTINCT ON (account_id, brief_id, type)
          id, account_id, brief_id, type
        FROM delivery_jobs
        ORDER BY account_id, brief_id, type, created_at ASC
      ) c
        ON c.account_id = j.account_id
       AND c.brief_id = j.brief_id
       AND c.type = j.type
    ) grouped
    GROUP BY canonical_id
  ) compared
  WHERE compared.old_count IS DISTINCT FROM compared.new_count;

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'attempt-count parity failed for % delivery jobs',
      mismatched;
  END IF;
END $$;

-- Drop duplicate intent rows only after attempts point at the canonical id.
DELETE FROM delivery_jobs dj
WHERE dj.id NOT IN (
  SELECT DISTINCT ON (account_id, brief_id, type) id
  FROM delivery_jobs
  ORDER BY account_id, brief_id, type, created_at ASC
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_jobs_account_brief_type_uidx
  ON delivery_jobs (account_id, brief_id, type);
