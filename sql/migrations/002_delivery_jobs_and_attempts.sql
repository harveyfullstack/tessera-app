-- Phase-2 schema split: immutable delivery_jobs intent + append-only
-- delivery_attempts history. Mutable jobs rows are renamed, duplicates on
-- (account_id, brief_id, type) collapse onto the earliest intent, and every
-- reconstructed attempt is copied onto that canonical job before the unique
-- constraint is applied. Legacy execution columns stay on delivery_jobs so
-- the 14-day rollback bar can still read jobs.status.

BEGIN;

CREATE TABLE jobs_pre_cutover_snapshot AS
SELECT * FROM jobs;

CREATE TABLE job_canonical_map AS
SELECT
  j.id AS source_id,
  canon.id AS canonical_id,
  CASE
    WHEN j.status = 'queued' AND j.started_at IS NULL AND j.retry_count = 0 THEN 0
    ELSE j.retry_count + 1
  END AS old_attempt_count
FROM jobs j
JOIN LATERAL (
  SELECT c.id
  FROM jobs c
  WHERE c.account_id = j.account_id
    AND c.brief_id = j.brief_id
    AND c.type = j.type
  ORDER BY c.created_at ASC, c.id ASC
  LIMIT 1
) canon ON TRUE;

UPDATE jobs child
SET parent_job_id = map.canonical_id
FROM job_canonical_map map
WHERE child.parent_job_id = map.source_id
  AND map.source_id <> map.canonical_id;

ALTER TABLE jobs RENAME TO delivery_jobs;

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX delivery_attempts_job_attempt_uidx
  ON delivery_attempts (delivery_job_id, attempt_number);

CREATE INDEX delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  response_status,
  response_latency_ms,
  error_body,
  started_at,
  completed_at,
  created_at
)
SELECT
  gen_random_uuid(),
  numbered.canonical_id,
  numbered.attempt_number,
  numbered.worker_id,
  numbered.status,
  numbered.response_status,
  numbered.response_latency_ms,
  numbered.error_body,
  numbered.started_at,
  numbered.completed_at,
  numbered.created_at
FROM (
  SELECT
    map.canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY map.canonical_id
      ORDER BY src.created_at ASC, src.id ASC, series.n ASC
    ) AS attempt_number,
    CASE WHEN series.n = map.old_attempt_count THEN src.worker_id END AS worker_id,
    CASE
      WHEN series.n = map.old_attempt_count THEN src.status
      ELSE 'failed'
    END AS status,
    NULL::INTEGER AS response_status,
    NULL::INTEGER AS response_latency_ms,
    CASE WHEN series.n = map.old_attempt_count THEN src.error_message END AS error_body,
    CASE WHEN series.n = map.old_attempt_count THEN src.started_at END AS started_at,
    CASE WHEN series.n = map.old_attempt_count THEN src.completed_at END AS completed_at,
    COALESCE(src.started_at, src.created_at) AS created_at
  FROM delivery_jobs src
  JOIN job_canonical_map map ON map.source_id = src.id
  JOIN LATERAL generate_series(1, map.old_attempt_count) AS series(n) ON map.old_attempt_count > 0
) numbered;

DELETE FROM delivery_jobs
WHERE id NOT IN (SELECT canonical_id FROM job_canonical_map);

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_account_brief_type_uidx
  UNIQUE (account_id, brief_id, type);

CREATE VIEW jobs AS
SELECT * FROM delivery_jobs;

DO $$
DECLARE
  old_total BIGINT;
  new_total BIGINT;
  mismatched BIGINT;
BEGIN
  SELECT COALESCE(SUM(old_attempt_count), 0)
  INTO old_total
  FROM job_canonical_map;

  SELECT COUNT(*)
  INTO new_total
  FROM delivery_attempts;

  IF old_total <> new_total THEN
    RAISE EXCEPTION
      'aggregate attempt-count parity failed: old=% new=%',
      old_total,
      new_total;
  END IF;

  SELECT COUNT(*)
  INTO mismatched
  FROM (
    SELECT
      canonical_id,
      SUM(old_attempt_count) AS old_count
    FROM job_canonical_map
    GROUP BY canonical_id
  ) old_by_job
  JOIN (
    SELECT
      delivery_job_id,
      COUNT(*) AS new_count
    FROM delivery_attempts
    GROUP BY delivery_job_id
  ) new_by_job ON new_by_job.delivery_job_id = old_by_job.canonical_id
  WHERE old_by_job.old_count <> new_by_job.new_count;

  -- Jobs with zero historical attempts are allowed to be absent from delivery_attempts.
  SELECT mismatched + COUNT(*)
  INTO mismatched
  FROM (
    SELECT
      canonical_id,
      SUM(old_attempt_count) AS old_count
    FROM job_canonical_map
    GROUP BY canonical_id
  ) old_by_job
  WHERE old_by_job.old_count > 0
    AND NOT EXISTS (
      SELECT 1
      FROM delivery_attempts a
      WHERE a.delivery_job_id = old_by_job.canonical_id
    );

  IF mismatched <> 0 THEN
    RAISE EXCEPTION
      'per-job attempt-count parity failed for % delivery job(s)',
      mismatched;
  END IF;
END $$;

COMMIT;
