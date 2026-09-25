BEGIN;

LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE type <> 'drain_dlq'
    GROUP BY account_id, brief_id, type
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot split jobs: duplicate non-DLQ intents must be reconciled first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE type = 'drain_dlq' AND parent_job_id IS NOT NULL
    GROUP BY account_id, brief_id, parent_job_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot split jobs: duplicate DLQ entries per parent must be reconciled first';
  END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE retry_count < 0) THEN
    RAISE EXCEPTION 'Cannot split jobs: retry_count cannot be negative';
  END IF;
END;
$$;

-- retry_count is the legacy attempt counter. A queued job has only its recorded
-- retries; running/completed jobs include the current attempt; failed jobs have
-- already incremented retry_count for the attempt that just failed.
CREATE TEMP TABLE legacy_job_attempt_counts ON COMMIT DROP AS
SELECT
  id AS delivery_job_id,
  CASE
    WHEN status = 'failed' THEN GREATEST(retry_count, 1)
    WHEN status = 'queued' THEN retry_count
    WHEN status IN ('running', 'completed') OR started_at IS NOT NULL
      THEN retry_count + 1
    ELSE retry_count
  END AS expected_attempt_count
FROM jobs;

ALTER TABLE jobs RENAME TO delivery_jobs;
ALTER TABLE delivery_jobs RENAME CONSTRAINT jobs_pkey TO delivery_jobs_pkey;
ALTER TABLE delivery_jobs
  RENAME CONSTRAINT jobs_parent_job_id_fkey TO delivery_jobs_parent_job_id_fkey;
ALTER INDEX jobs_account_brief_idx RENAME TO delivery_jobs_account_brief_idx;
DROP INDEX jobs_status_idx;

CREATE UNIQUE INDEX delivery_jobs_account_brief_type_key
  ON delivery_jobs (account_id, brief_id, type)
  WHERE type <> 'drain_dlq';

CREATE UNIQUE INDEX delivery_jobs_dlq_parent_key
  ON delivery_jobs (account_id, brief_id, parent_job_id)
  WHERE type = 'drain_dlq' AND parent_job_id IS NOT NULL;

CREATE TABLE delivery_attempts (
  delivery_job_id UUID NOT NULL
    REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_job_attempt_key
    UNIQUE (delivery_job_id, attempt_number)
);

-- The legacy row retained only its current execution snapshot. Preserve the
-- counter as numbered rows, marking overwritten outcomes unknown and copying
-- the latest available details; the legacy schema has no response metrics.
INSERT INTO delivery_attempts (
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  completed_at,
  recorded_at
)
SELECT
  job.id,
  attempt.attempt_number,
  CASE
    WHEN attempt.attempt_number = counts.expected_attempt_count
      AND job.status <> 'queued'
      THEN job.worker_id
  END,
  CASE
    WHEN attempt.attempt_number <> counts.expected_attempt_count
      OR job.status = 'queued'
      THEN 'unknown'
    ELSE job.status
  END,
  CASE
    WHEN attempt.attempt_number = counts.expected_attempt_count
      THEN job.error_message
  END,
  CASE
    WHEN attempt.attempt_number = counts.expected_attempt_count
      THEN job.started_at
  END,
  CASE
    WHEN attempt.attempt_number = counts.expected_attempt_count
      THEN job.completed_at
  END,
  CASE
    WHEN attempt.attempt_number = counts.expected_attempt_count
      THEN job.updated_at
    ELSE job.created_at
  END
FROM delivery_jobs AS job
JOIN legacy_job_attempt_counts AS counts
  ON counts.delivery_job_id = job.id
CROSS JOIN LATERAL generate_series(
  1,
  counts.expected_attempt_count
) AS attempt(attempt_number);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_job_attempt_counts AS legacy
    LEFT JOIN (
      SELECT delivery_job_id, COUNT(*) AS attempt_count
      FROM delivery_attempts
      GROUP BY delivery_job_id
    ) AS migrated USING (delivery_job_id)
    WHERE legacy.expected_attempt_count <> COALESCE(migrated.attempt_count, 0)
  ) THEN
    RAISE EXCEPTION 'Delivery attempt parity check failed for one or more jobs';
  END IF;

  IF
    (SELECT COALESCE(SUM(expected_attempt_count), 0) FROM legacy_job_attempt_counts)
    <>
    (SELECT COUNT(*) FROM delivery_attempts)
  THEN
    RAISE EXCEPTION 'Aggregate delivery attempt parity check failed';
  END IF;
END;
$$;

ALTER TABLE delivery_jobs
  DROP COLUMN status,
  DROP COLUMN worker_id,
  DROP COLUMN retry_count,
  DROP COLUMN error_message,
  DROP COLUMN started_at,
  DROP COLUMN completed_at;

CREATE INDEX delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

CREATE FUNCTION reject_delivery_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a new delivery attempt instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE OR DELETE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();

COMMIT;
