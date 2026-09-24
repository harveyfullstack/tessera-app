-- Immutable delivery intent (delivery_jobs) and append-only execution history
-- (delivery_attempts). The Phase 1 jobs table is retained: it is still the retry
-- queue, and a per-account rollback can keep reading it. This is a copy, not an
-- in-place rename, so rolling back does not require rebuilding jobs.
--
-- Canonical intent is the earliest jobs row for (account_id, brief_id, type).
-- Duplicate rows that disagree on metadata, task_id, or canonical parent abort
-- the migration instead of dropping intent.
--
-- Attempt-count rule, shared with legacyJobAttemptCount:
--   queued AND started_at IS NULL -> retry_count
--   failed                       -> GREATEST(retry_count, 1)
--   otherwise                    -> retry_count + 1
-- The mutable jobs row only kept the latest execution. Earlier attempts that
-- were overwritten are rebuilt as status failed with a null body so the count
-- matches. The latest attempt copies worker_id, status, and error_message
-- (as error_body). response_status and response_latency_ms were never stored.
--
-- Run this file as its own transaction (it issues BEGIN/COMMIT).

BEGIN;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM jobs WHERE retry_count < 0) THEN
    RAISE EXCEPTION 'retry_count must be a non-negative integer';
  END IF;
END
$do$;

CREATE FUNCTION legacy_job_attempt_count(
  p_status TEXT,
  p_retry_count INTEGER,
  p_started_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_status = 'queued' AND p_started_at IS NULL THEN p_retry_count
    WHEN p_status = 'failed' THEN GREATEST(p_retry_count, 1)
    ELSE p_retry_count + 1
  END;
$fn$;

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type)
);

CREATE TABLE delivery_job_sources (
  legacy_job_id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL,
  is_canonical BOOLEAN NOT NULL
);

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  CONSTRAINT delivery_attempts_attempt_number_positive CHECK (attempt_number >= 1),
  CONSTRAINT delivery_attempts_job_attempt_key UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

INSERT INTO delivery_job_sources (legacy_job_id, delivery_job_id, is_canonical)
SELECT
  ranked.id,
  ranked.canonical_id,
  ranked.id = ranked.canonical_id
FROM (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY account_id, brief_id, type
      ORDER BY created_at ASC, id ASC
    ) AS canonical_id
  FROM jobs
) AS ranked;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs AS legacy
    JOIN delivery_job_sources AS source ON source.legacy_job_id = legacy.id
    JOIN jobs AS canonical ON canonical.id = source.delivery_job_id
    LEFT JOIN delivery_job_sources AS legacy_parent
      ON legacy_parent.legacy_job_id = legacy.parent_job_id
    LEFT JOIN delivery_job_sources AS canonical_parent
      ON canonical_parent.legacy_job_id = canonical.parent_job_id
    WHERE legacy.metadata IS DISTINCT FROM canonical.metadata
       OR legacy.task_id IS DISTINCT FROM canonical.task_id
       OR legacy_parent.delivery_job_id IS DISTINCT FROM canonical_parent.delivery_job_id
  ) THEN
    RAISE EXCEPTION
      'duplicate (account_id, brief_id, type) rows disagree on intent; refusing migration';
  END IF;
END
$do$;

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
SELECT
  legacy.id,
  legacy.account_id,
  legacy.brief_id,
  legacy.task_id,
  NULL,
  legacy.type,
  legacy.metadata,
  legacy.created_at
FROM jobs AS legacy
JOIN delivery_job_sources AS source
  ON source.legacy_job_id = legacy.id
 AND source.is_canonical;

UPDATE delivery_jobs AS delivery_job
SET parent_job_id = parent_source.delivery_job_id
FROM jobs AS legacy
JOIN delivery_job_sources AS parent_source
  ON parent_source.legacy_job_id = legacy.parent_job_id
WHERE delivery_job.id = legacy.id
  AND legacy.parent_job_id IS NOT NULL;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM delivery_jobs AS delivery_job
    JOIN jobs AS legacy ON legacy.id = delivery_job.id
    WHERE legacy.parent_job_id IS NOT NULL
      AND delivery_job.parent_job_id IS NULL
  ) THEN
    RAISE EXCEPTION 'orphan parent_job_id; refusing migration';
  END IF;
END
$do$;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_parent_fk
  FOREIGN KEY (parent_job_id) REFERENCES delivery_jobs (id) ON DELETE RESTRICT;

ALTER TABLE delivery_job_sources
  ADD CONSTRAINT delivery_job_sources_job_fk
  FOREIGN KEY (delivery_job_id) REFERENCES delivery_jobs (id) ON DELETE RESTRICT;

ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_job_fk
  FOREIGN KEY (delivery_job_id) REFERENCES delivery_jobs (id) ON DELETE RESTRICT;

INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  response_status,
  response_latency_ms,
  error_body
)
SELECT
  gen_random_uuid(),
  numbered.delivery_job_id,
  numbered.attempt_number,
  CASE WHEN numbered.is_latest THEN numbered.worker_id ELSE NULL END,
  CASE WHEN numbered.is_latest THEN numbered.status ELSE 'failed' END,
  NULL,
  NULL,
  CASE WHEN numbered.is_latest THEN numbered.error_message ELSE NULL END
FROM (
  SELECT
    expanded.delivery_job_id,
    expanded.worker_id,
    expanded.status,
    expanded.error_message,
    expanded.local_n = expanded.attempt_count AS is_latest,
    ROW_NUMBER() OVER (
      PARTITION BY expanded.delivery_job_id
      ORDER BY expanded.created_at ASC, expanded.legacy_job_id ASC, expanded.local_n ASC
    )::INTEGER AS attempt_number
  FROM (
    SELECT
      per_legacy.legacy_job_id,
      per_legacy.delivery_job_id,
      per_legacy.created_at,
      per_legacy.worker_id,
      per_legacy.status,
      per_legacy.error_message,
      per_legacy.attempt_count,
      gs.local_n
    FROM (
      SELECT
        legacy.id AS legacy_job_id,
        source.delivery_job_id,
        legacy.created_at,
        legacy.worker_id,
        legacy.status,
        legacy.error_message,
        legacy_job_attempt_count(legacy.status, legacy.retry_count, legacy.started_at) AS attempt_count
      FROM jobs AS legacy
      JOIN delivery_job_sources AS source ON source.legacy_job_id = legacy.id
    ) AS per_legacy
    JOIN LATERAL generate_series(1, per_legacy.attempt_count) AS gs(local_n)
      ON per_legacy.attempt_count >= 1
  ) AS expanded
) AS numbered;

CREATE VIEW delivery_attempt_parity AS
SELECT
  ids.delivery_job_id,
  COALESCE(legacy_counts.old_count, 0) AS legacy_attempt_count,
  COALESCE(attempt_counts.new_count, 0) AS delivery_attempt_count
FROM (
  SELECT DISTINCT delivery_job_id FROM delivery_job_sources
) AS ids
LEFT JOIN (
  SELECT
    source.delivery_job_id,
    SUM(legacy_job_attempt_count(legacy.status, legacy.retry_count, legacy.started_at)) AS old_count
  FROM jobs AS legacy
  JOIN delivery_job_sources AS source ON source.legacy_job_id = legacy.id
  GROUP BY source.delivery_job_id
) AS legacy_counts USING (delivery_job_id)
LEFT JOIN (
  SELECT delivery_job_id, COUNT(*) AS new_count
  FROM delivery_attempts
  GROUP BY delivery_job_id
) AS attempt_counts USING (delivery_job_id);

DO $do$
DECLARE
  unmapped INTEGER;
  delivery_job_count INTEGER;
  canonical_group_count INTEGER;
  mismatched INTEGER;
  legacy_total BIGINT;
  attempt_total BIGINT;
BEGIN
  SELECT COUNT(*) INTO unmapped
  FROM jobs AS legacy
  WHERE NOT EXISTS (
    SELECT 1 FROM delivery_job_sources AS source WHERE source.legacy_job_id = legacy.id
  );
  IF unmapped <> 0 THEN
    RAISE EXCEPTION 'delivery migration lost % legacy intent rows', unmapped;
  END IF;

  SELECT COUNT(*) INTO delivery_job_count FROM delivery_jobs;
  SELECT COUNT(DISTINCT delivery_job_id) INTO canonical_group_count FROM delivery_job_sources;
  IF delivery_job_count <> canonical_group_count THEN
    RAISE EXCEPTION
      'delivery_jobs count % does not match canonical groups %',
      delivery_job_count,
      canonical_group_count;
  END IF;

  SELECT COUNT(*) INTO mismatched
  FROM delivery_attempt_parity
  WHERE legacy_attempt_count <> delivery_attempt_count;
  IF mismatched <> 0 THEN
    RAISE EXCEPTION 'attempt-count parity failed for % delivery jobs', mismatched;
  END IF;

  SELECT COALESCE(SUM(legacy_job_attempt_count(status, retry_count, started_at)), 0)
    INTO legacy_total
  FROM jobs;
  SELECT COUNT(*) INTO attempt_total FROM delivery_attempts;
  IF legacy_total <> attempt_total THEN
    RAISE EXCEPTION
      'aggregate attempt-count parity failed: legacy % <> attempts %',
      legacy_total,
      attempt_total;
  END IF;
END
$do$;

CREATE TABLE delivery_attempt_parity_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  delivery_job_id UUID,
  legacy_attempt_count BIGINT NOT NULL,
  delivery_attempt_count BIGINT NOT NULL,
  proved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempt_parity_proofs_scope_check
    CHECK (scope IN ('job', 'aggregate')),
  CONSTRAINT delivery_attempt_parity_proofs_match_check
    CHECK (legacy_attempt_count = delivery_attempt_count),
  CONSTRAINT delivery_attempt_parity_proofs_scope_shape_check
    CHECK (
      (scope = 'aggregate' AND delivery_job_id IS NULL)
      OR (scope = 'job' AND delivery_job_id IS NOT NULL)
    ),
  CONSTRAINT delivery_attempt_parity_proofs_job_fk
    FOREIGN KEY (delivery_job_id) REFERENCES delivery_jobs (id) ON DELETE RESTRICT
);

INSERT INTO delivery_attempt_parity_proofs (
  scope,
  delivery_job_id,
  legacy_attempt_count,
  delivery_attempt_count
)
SELECT
  'job',
  delivery_job_id,
  legacy_attempt_count,
  delivery_attempt_count
FROM delivery_attempt_parity;

INSERT INTO delivery_attempt_parity_proofs (
  scope,
  delivery_job_id,
  legacy_attempt_count,
  delivery_attempt_count
)
SELECT
  'aggregate',
  NULL,
  COALESCE(SUM(legacy_attempt_count), 0),
  COALESCE(SUM(delivery_attempt_count), 0)
FROM delivery_attempt_parity;

CREATE FUNCTION reject_delivery_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'delivery_attempts is append-only';
END;
$fn$;

CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW
  EXECUTE PROCEDURE reject_delivery_attempt_mutation();

CREATE FUNCTION reject_delivery_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'delivery_jobs intent is immutable';
END;
$fn$;

CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE OR DELETE ON delivery_jobs
  FOR EACH ROW
  EXECUTE PROCEDURE reject_delivery_job_mutation();

COMMIT;
