BEGIN;

LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jobs WHERE retry_count < 0) THEN
    RAISE EXCEPTION 'Cannot split jobs: retry_count cannot be negative';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE jsonb_typeof(metadata -> 'endpointUrl') IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'Cannot split jobs: every delivery must have a string metadata.endpointUrl';
  END IF;
END;
$$;

-- Keep the earliest row as the immutable intent for each delivery. Duplicate
-- legacy rows for the same exact endpoint are retained in the mapping so
-- their execution history is not discarded during the split.
CREATE TEMP TABLE legacy_delivery_job_map ON COMMIT DROP AS
SELECT
  j.id AS legacy_job_id,
  FIRST_VALUE(j.id) OVER (
    PARTITION BY
      j.account_id,
      j.brief_id,
      j.type,
      (j.metadata ->> 'endpointUrl') COLLATE "C"
    ORDER BY j.created_at ASC, j.id ASC
  ) AS delivery_job_id
FROM jobs AS j;

CREATE TEMP TABLE legacy_attempt_counts ON COMMIT DROP AS
SELECT
  j.id AS legacy_job_id,
  m.delivery_job_id,
  CASE
    WHEN j.status = 'queued'
      AND j.worker_id IS NULL
      AND j.started_at IS NULL
      AND j.completed_at IS NULL
      THEN j.retry_count
    WHEN j.status = 'failed'
      THEN GREATEST(j.retry_count, 1)
    ELSE j.retry_count + 1
  END AS expected_attempt_count
FROM jobs AS j
JOIN legacy_delivery_job_map AS m ON m.legacy_job_id = j.id;

CREATE TEMP TABLE legacy_attempt_ranges ON COMMIT DROP AS
SELECT
  c.*,
  COALESCE(
    SUM(c.expected_attempt_count) OVER (
      PARTITION BY c.delivery_job_id
      ORDER BY j.created_at ASC, j.id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ),
    0
  ) AS attempt_offset
FROM legacy_attempt_counts AS c
JOIN jobs AS j ON j.id = c.legacy_job_id;

ALTER TABLE jobs RENAME TO jobs_legacy;

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_jobs_endpoint_url_string
    CHECK (
      jsonb_typeof(metadata -> 'endpointUrl') IS NOT DISTINCT FROM 'string'
    )
);

-- The approved endpoint identity keeps URLs exact: no case, slash, or other
-- normalization is applied, and C collation preserves bytewise string equality.
CREATE UNIQUE INDEX delivery_jobs_account_brief_type_endpoint_key
  ON delivery_jobs (
    account_id,
    brief_id,
    type,
    ((metadata ->> 'endpointUrl') COLLATE "C")
  );

CREATE INDEX delivery_jobs_account_brief_idx
  ON delivery_jobs (account_id, brief_id);

-- Insert all canonical intent rows first, then restore self-references after
-- duplicate legacy parent IDs have been resolved to their canonical rows.
INSERT INTO delivery_jobs (
  id,
  account_id,
  brief_id,
  task_id,
  type,
  metadata,
  created_at
)
SELECT
  j.id,
  j.account_id,
  j.brief_id,
  j.task_id,
  j.type,
  j.metadata,
  j.created_at
FROM jobs_legacy AS j
JOIN legacy_delivery_job_map AS m ON m.legacy_job_id = j.id
WHERE m.legacy_job_id = m.delivery_job_id;

UPDATE delivery_jobs AS target
SET parent_job_id = parent_map.delivery_job_id
FROM jobs_legacy AS source
JOIN legacy_delivery_job_map AS source_map
  ON source_map.legacy_job_id = source.id
JOIN legacy_delivery_job_map AS parent_map
  ON parent_map.legacy_job_id = source.parent_job_id
WHERE target.id = source_map.delivery_job_id
  AND source_map.legacy_job_id = source_map.delivery_job_id
  AND source.parent_job_id IS NOT NULL;

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_attempts_job_attempt_key
    UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- A legacy row stores only its latest execution snapshot. Reconstruct the
-- numbered history from retry_count, retaining the latest available details
-- and marking overwritten history as an explicit synthetic failure.
INSERT INTO delivery_attempts (
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  completed_at,
  created_at
)
SELECT
  ranges.delivery_job_id,
  ranges.attempt_offset + attempts.attempt_number,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.worker_id
  END,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.status
    ELSE 'failed'
  END,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.error_message
    ELSE 'Historical attempt retried (pre-migration backfill)'
  END,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.started_at
  END,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.completed_at
  END,
  CASE
    WHEN attempts.attempt_number = ranges.expected_attempt_count
      THEN legacy.updated_at
    ELSE legacy.created_at
  END
FROM legacy_attempt_ranges AS ranges
JOIN jobs_legacy AS legacy ON legacy.id = ranges.legacy_job_id
CROSS JOIN LATERAL generate_series(
  1,
  ranges.expected_attempt_count
) AS attempts(attempt_number);

-- Parity is asserted while both the legacy snapshot and the new history are
-- available. A failure aborts the transaction before cutover can commit.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        delivery_job_id,
        SUM(expected_attempt_count) AS expected_attempt_count
      FROM legacy_attempt_counts
      GROUP BY delivery_job_id
    ) AS legacy
    FULL JOIN (
      SELECT
        delivery_job_id,
        COUNT(*) AS migrated_attempt_count
      FROM delivery_attempts
      GROUP BY delivery_job_id
    ) AS migrated USING (delivery_job_id)
    WHERE COALESCE(legacy.expected_attempt_count, 0)
      <> COALESCE(migrated.migrated_attempt_count, 0)
  ) THEN
    RAISE EXCEPTION 'Delivery attempt parity check failed for one or more delivery jobs';
  END IF;

  IF
    (SELECT COALESCE(SUM(expected_attempt_count), 0) FROM legacy_attempt_counts)
    <> (SELECT COUNT(*) FROM delivery_attempts)
  THEN
    RAISE EXCEPTION 'Aggregate delivery attempt parity check failed';
  END IF;
END;
$$;

CREATE VIEW jobs AS
SELECT *
FROM jobs_legacy;

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
  FOR EACH ROW
  EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW
  EXECUTE FUNCTION reject_delivery_history_mutation();

COMMIT;
