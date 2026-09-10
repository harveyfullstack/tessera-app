-- Phase-2 schema split: immutable delivery_jobs intent + append-only attempts.
-- Renames jobs -> delivery_jobs, collapses duplicate intent rows onto the
-- earliest (account_id, brief_id, type) winner, seeds delivery_attempts from
-- every source row, and refuses cutover unless per-job and aggregate
-- attempt-count parity holds.

BEGIN;

CREATE TEMP TABLE jobs_attempt_baseline AS
SELECT
  id,
  account_id,
  brief_id,
  type,
  created_at,
  status,
  worker_id,
  retry_count,
  error_message,
  started_at,
  CASE
    WHEN status = 'queued' AND retry_count = 0 THEN 0
    WHEN status = 'queued' THEN retry_count
    ELSE retry_count + 1
  END AS old_attempt_count
FROM jobs;

CREATE TEMP TABLE delivery_job_canonical AS
SELECT DISTINCT ON (account_id, brief_id, type)
  id AS canonical_id,
  account_id,
  brief_id,
  type
FROM jobs
ORDER BY account_id, brief_id, type, created_at ASC, id ASC;

CREATE TEMP TABLE delivery_job_remap AS
SELECT
  j.id AS source_id,
  c.canonical_id
FROM jobs j
JOIN delivery_job_canonical c
  ON c.account_id = j.account_id
 AND c.brief_id = j.brief_id
 AND c.type = j.type;

ALTER TABLE jobs RENAME TO delivery_jobs;
ALTER INDEX jobs_account_brief_idx RENAME TO delivery_jobs_account_brief_idx;
ALTER INDEX jobs_status_idx RENAME TO delivery_jobs_status_idx;

UPDATE delivery_jobs child
SET parent_job_id = remap.canonical_id
FROM delivery_job_remap remap
WHERE child.parent_job_id = remap.source_id
  AND remap.source_id <> remap.canonical_id;

-- Append-only history. No ON DELETE CASCADE: removing a delivery_jobs row
-- must not take attempt history with it.
CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs (id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_job_number_uidx UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

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
  gen_random_uuid(),
  numbered.canonical_id,
  numbered.attempt_number,
  CASE
    WHEN numbered.attempt_in_source = numbered.old_attempt_count THEN numbered.worker_id
  END,
  CASE
    WHEN numbered.attempt_in_source = numbered.old_attempt_count THEN numbered.status
    ELSE 'failed'
  END,
  CASE
    WHEN numbered.attempt_in_source = numbered.old_attempt_count THEN numbered.error_message
  END,
  CASE
    WHEN numbered.attempt_in_source = numbered.old_attempt_count THEN numbered.started_at
  END
FROM (
  SELECT
    expanded.*,
    ROW_NUMBER() OVER (
      PARTITION BY expanded.canonical_id
      ORDER BY expanded.source_created_at, expanded.source_id, expanded.attempt_in_source
    ) AS attempt_number
  FROM (
    SELECT
      remap.canonical_id,
      baseline.id AS source_id,
      baseline.created_at AS source_created_at,
      series.attempt_in_source,
      baseline.old_attempt_count,
      baseline.status,
      baseline.worker_id,
      baseline.error_message,
      baseline.started_at
    FROM jobs_attempt_baseline baseline
    JOIN delivery_job_remap remap ON remap.source_id = baseline.id
    JOIN LATERAL generate_series(1, GREATEST(baseline.old_attempt_count, 0)) AS series(attempt_in_source)
      ON TRUE
  ) expanded
) numbered;

DO $$
DECLARE
  per_job_mismatches BIGINT;
  old_total BIGINT;
  new_total BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO per_job_mismatches
  FROM (
    SELECT
      remap.canonical_id,
      SUM(baseline.old_attempt_count) AS old_count,
      (
        SELECT COUNT(*)
        FROM delivery_attempts attempts
        WHERE attempts.delivery_job_id = remap.canonical_id
      ) AS new_count
    FROM jobs_attempt_baseline baseline
    JOIN delivery_job_remap remap ON remap.source_id = baseline.id
    GROUP BY remap.canonical_id
  ) counts
  WHERE counts.old_count IS DISTINCT FROM counts.new_count;

  IF per_job_mismatches <> 0 THEN
    RAISE EXCEPTION
      'per-job attempt-count parity failed: % delivery jobs mismatched',
      per_job_mismatches;
  END IF;

  SELECT COALESCE(SUM(old_attempt_count), 0) INTO old_total FROM jobs_attempt_baseline;
  SELECT COUNT(*) INTO new_total FROM delivery_attempts;

  IF old_total <> new_total THEN
    RAISE EXCEPTION
      'aggregate attempt-count parity failed: old=% new=%',
      old_total,
      new_total;
  END IF;
END $$;

DELETE FROM delivery_jobs
WHERE id NOT IN (SELECT canonical_id FROM delivery_job_canonical);

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_account_brief_type_uidx
  UNIQUE (account_id, brief_id, type);

-- Rollback-compatible alias: jobs.status remains readable while execution
-- truth moves to delivery_attempts.
CREATE VIEW jobs AS
SELECT * FROM delivery_jobs;

COMMIT;
