-- Phase 2 schema split for webhook delivery (TESSERA-1880).
--
-- jobs is renamed to delivery_jobs and becomes the immutable delivery intent,
-- unique on (account_id, brief_id, type). Execution history moves to the
-- append-only delivery_attempts table.
--
-- Rollback compatibility: the legacy execution columns (status, worker_id,
-- retry_count, error_message, started_at, completed_at, updated_at) stay on
-- delivery_jobs and stay writable, and a `jobs` view exposes the old table
-- shape. Reads of jobs.status and writes through the old path keep working
-- while the per-account rollback flag is on.
--
-- Pre-existing duplicate intent rows (from ensureJobRecord retry races) are
-- merged into the earliest row per (account_id, brief_id, type). Each
-- duplicate is archived verbatim in delivery_jobs_merged_duplicates and its
-- attempts are backfilled under the canonical job, so nothing is lost.
--
-- The migration fails and rolls back if row counts or old/new attempt
-- counts do not match, per job and in aggregate.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Rename jobs -> delivery_jobs
-- ---------------------------------------------------------------------------

ALTER TABLE jobs RENAME TO delivery_jobs;
ALTER TABLE delivery_jobs RENAME CONSTRAINT jobs_pkey TO delivery_jobs_pkey;
ALTER TABLE delivery_jobs
  RENAME CONSTRAINT jobs_parent_job_id_fkey TO delivery_jobs_parent_job_id_fkey;
ALTER INDEX jobs_status_idx RENAME TO delivery_jobs_status_idx;

-- ---------------------------------------------------------------------------
-- 2. Legacy attempt count: how many runs the old row has started
-- ---------------------------------------------------------------------------
-- Matches the only production writer, DeliveryOrchestrator.deliver
-- (src/application/delivery-orchestrator.ts). It calls markRunning. On
-- failure it calls retry(), which increments retry_count, and then
-- markFailed. On success it calls markCompleted. So at rest:
--   started_at NULL                   -> 0 runs
--   status 'failed'                   -> retry_count runs, because each failed
--                                        run incremented retry_count before
--                                        markFailed
--   'running', 'completed' or
--   'cancelled' (no writer)           -> retry_count + 1 runs, which is the
--                                        earlier failed runs plus the current one
-- A started 'failed' row with retry_count = 0 (markFailed without retry, a
-- path no production caller uses) still counts its one run. It is never
-- counted as zero.

CREATE FUNCTION delivery_jobs_legacy_attempt_count(
  p_status TEXT,
  p_retry_count INTEGER,
  p_started_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_started_at IS NULL THEN 0
    WHEN p_status = 'failed' THEN GREATEST(p_retry_count, 1)
    ELSE p_retry_count + 1
  END
$$;

CREATE TEMP TABLE migration_002_baseline ON COMMIT DROP AS
SELECT
  COUNT(*) AS job_rows,
  COALESCE(SUM(delivery_jobs_legacy_attempt_count(
    status, retry_count, started_at
  )), 0) AS legacy_attempts
FROM delivery_jobs;

-- ---------------------------------------------------------------------------
-- 3. Pick one canonical row per (account_id, brief_id, type)
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE migration_002_canonical ON COMMIT DROP AS
SELECT
  id AS job_id,
  FIRST_VALUE(id) OVER (
    PARTITION BY account_id, brief_id, type
    ORDER BY created_at, id
  ) AS canonical_job_id
FROM delivery_jobs;

CREATE TABLE delivery_jobs_merged_duplicates (
  LIKE delivery_jobs INCLUDING DEFAULTS,
  canonical_job_id UUID NOT NULL
    REFERENCES delivery_jobs (id) ON DELETE RESTRICT,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);

CREATE INDEX delivery_jobs_merged_duplicates_canonical_idx
  ON delivery_jobs_merged_duplicates (canonical_job_id);

INSERT INTO delivery_jobs_merged_duplicates
SELECT j.*, c.canonical_job_id, NOW()
FROM delivery_jobs j
JOIN migration_002_canonical c ON c.job_id = j.id
WHERE c.job_id <> c.canonical_job_id;

-- ---------------------------------------------------------------------------
-- 4. Append-only delivery_attempts
-- ---------------------------------------------------------------------------
-- The FK is ON DELETE RESTRICT, never CASCADE, so deleting a delivery_jobs
-- row cannot take its history with it. One DESC unique index enforces
-- (delivery_job_id, attempt_number) uniqueness and serves latest-attempt
-- reads.

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL
    REFERENCES delivery_jobs (id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ,
  -- true for rows reconstructed from legacy jobs columns by this migration.
  backfilled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- ---------------------------------------------------------------------------
-- 5. Backfill attempts from legacy rows, including merged duplicates
-- ---------------------------------------------------------------------------
-- Each legacy run becomes a 'running' row, then a terminal row if the run
-- ended. Every run before the latest one failed, because another run followed
-- it. The latest run ends with the row's status, unless it is still running.
-- A failed row with retry_count = n therefore gets n running/failed pairs.
-- No 'queued' rows are written for scheduled retries. Worker and error
-- details of earlier runs were overwritten in the old model, so they stay
-- NULL. The latest run takes the row's worker_id, error_message and timestamps.
-- attempt_number orders runs across a merged group by (created_at, id).

WITH runs AS (
  SELECT
    c.canonical_job_id,
    j.id AS source_job_id,
    j.created_at AS source_created_at,
    j.status AS job_status,
    j.worker_id,
    j.error_message,
    j.started_at,
    j.completed_at,
    j.updated_at,
    n.total,
    k.run
  FROM delivery_jobs j
  JOIN migration_002_canonical c ON c.job_id = j.id
  CROSS JOIN LATERAL (
    SELECT delivery_jobs_legacy_attempt_count(
      j.status, j.retry_count, j.started_at
    ) AS total
  ) n
  CROSS JOIN LATERAL generate_series(1, n.total) AS k(run)
),
events AS (
  SELECT
    r.canonical_job_id, r.source_created_at, r.source_job_id, r.run,
    1 AS phase,
    'running' AS status,
    CASE WHEN r.run = r.total THEN r.worker_id END AS worker_id,
    NULL::TEXT AS error_body,
    CASE WHEN r.run = r.total THEN r.started_at END AS started_at,
    CASE WHEN r.run = r.total THEN r.started_at ELSE r.source_created_at END
      AS created_at
  FROM runs r
  UNION ALL
  SELECT
    r.canonical_job_id, r.source_created_at, r.source_job_id, r.run,
    2 AS phase,
    CASE WHEN r.run < r.total THEN 'failed' ELSE r.job_status END AS status,
    CASE WHEN r.run = r.total THEN r.worker_id END AS worker_id,
    CASE WHEN r.run = r.total THEN r.error_message END AS error_body,
    CASE WHEN r.run = r.total THEN r.started_at END AS started_at,
    CASE
      WHEN r.run = r.total THEN COALESCE(r.completed_at, r.updated_at)
      ELSE r.source_created_at
    END AS created_at
  FROM runs r
  WHERE r.run < r.total
     OR r.job_status IN ('completed', 'failed', 'cancelled')
)
INSERT INTO delivery_attempts (
  delivery_job_id, attempt_number, worker_id, status, error_body,
  started_at, backfilled, created_at
)
SELECT
  e.canonical_job_id,
  ROW_NUMBER() OVER (
    PARTITION BY e.canonical_job_id
    ORDER BY e.source_created_at, e.source_job_id, e.run, e.phase
  ),
  e.worker_id,
  e.status,
  e.error_body,
  e.started_at,
  TRUE,
  e.created_at
FROM events e;

-- ---------------------------------------------------------------------------
-- 6. Collapse duplicates and enforce intent uniqueness
-- ---------------------------------------------------------------------------

UPDATE delivery_jobs j
SET parent_job_id = c.canonical_job_id
FROM migration_002_canonical c
WHERE j.parent_job_id = c.job_id
  AND c.job_id <> c.canonical_job_id;

DELETE FROM delivery_jobs j
USING migration_002_canonical c
WHERE j.id = c.job_id
  AND c.job_id <> c.canonical_job_id;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_account_brief_type_key
  UNIQUE (account_id, brief_id, type);

-- The unique index above leads with (account_id, brief_id).
DROP INDEX jobs_account_brief_idx;

-- ---------------------------------------------------------------------------
-- 7. Immutability guards
-- ---------------------------------------------------------------------------
-- Intent columns on delivery_jobs are frozen. Legacy execution columns stay
-- writable for the rollback path. delivery_attempts rejects UPDATE, DELETE
-- and TRUNCATE.

CREATE FUNCTION delivery_jobs_reject_intent_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.account_id, NEW.brief_id, NEW.task_id, NEW.parent_job_id,
      NEW.type, NEW.metadata, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.account_id, OLD.brief_id, OLD.task_id, OLD.parent_job_id,
      OLD.type, OLD.metadata, OLD.created_at)
  THEN
    RAISE EXCEPTION 'delivery_jobs intent is immutable (job %)', OLD.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER delivery_jobs_intent_immutable
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION delivery_jobs_reject_intent_update();

CREATE FUNCTION delivery_attempts_reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery_attempts is append-only (% rejected)', TG_OP;
END
$$;

CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION delivery_attempts_reject_mutation();

CREATE TRIGGER delivery_attempts_no_truncate
  BEFORE TRUNCATE ON delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION delivery_attempts_reject_mutation();

-- ---------------------------------------------------------------------------
-- 8. Legacy read/write path for the rollback flag
-- ---------------------------------------------------------------------------
-- A simple view is auto-updatable. SELECT status FROM jobs and the old
-- UPDATE jobs SET status = ... writes keep working. The intent trigger
-- still applies to writes that go through the view.

CREATE VIEW jobs AS
SELECT
  id, account_id, brief_id, task_id, parent_job_id, type, metadata,
  status, worker_id, retry_count, error_message,
  started_at, completed_at, created_at, updated_at
FROM delivery_jobs;

-- ---------------------------------------------------------------------------
-- 9. Old/new attempt-count parity
-- ---------------------------------------------------------------------------
-- Old side: legacy attempt count of the canonical row plus its merged
-- duplicates. New side: 'running' rows in delivery_attempts, one per started
-- run. The RPC writes one row per state transition, so COUNT(*) counts
-- transitions, not runs.

CREATE VIEW delivery_attempt_parity AS
WITH legacy AS (
  SELECT
    j.id AS delivery_job_id,
    j.account_id,
    delivery_jobs_legacy_attempt_count(
      j.status, j.retry_count, j.started_at
    ) + COALESCE((
      SELECT SUM(delivery_jobs_legacy_attempt_count(
        d.status, d.retry_count, d.started_at
      ))
      FROM delivery_jobs_merged_duplicates d
      WHERE d.canonical_job_id = j.id
    ), 0)::INTEGER AS legacy_attempt_count
  FROM delivery_jobs j
),
attempts AS (
  SELECT
    delivery_job_id,
    COUNT(*) FILTER (WHERE status = 'running')::INTEGER AS attempt_count,
    MAX(attempt_number) AS latest_attempt_number
  FROM delivery_attempts
  GROUP BY delivery_job_id
)
SELECT
  l.delivery_job_id,
  l.account_id,
  l.legacy_attempt_count,
  COALESCE(a.attempt_count, 0) AS attempt_count,
  a.latest_attempt_number,
  l.legacy_attempt_count = COALESCE(a.attempt_count, 0) AS in_parity
FROM legacy l
LEFT JOIN attempts a ON a.delivery_job_id = l.delivery_job_id;

-- Returns one row per account (scope = 'account') and one total row
-- (scope = 'all', account_id NULL).
CREATE VIEW delivery_attempt_parity_summary AS
SELECT
  CASE WHEN GROUPING(account_id) = 1 THEN 'all' ELSE 'account' END AS scope,
  account_id,
  COUNT(*) AS jobs_checked,
  COUNT(*) FILTER (WHERE NOT in_parity) AS jobs_out_of_parity,
  COALESCE(SUM(legacy_attempt_count), 0) AS legacy_attempt_total,
  COALESCE(SUM(attempt_count), 0) AS attempt_total,
  COUNT(*) FILTER (WHERE NOT in_parity) = 0
    AND COALESCE(SUM(legacy_attempt_count), 0) = COALESCE(SUM(attempt_count), 0)
    AS in_parity
FROM delivery_attempt_parity
GROUP BY GROUPING SETS ((account_id), ());

-- ---------------------------------------------------------------------------
-- 10. Check that no rows were lost or duplicated, and that parity holds
-- ---------------------------------------------------------------------------
-- The row-count check is independent of the count formula. The parity check
-- confirms that the backfill agrees with delivery_jobs_legacy_attempt_count.
-- It cannot catch a wrong formula, because both sides use the same function.
-- The formula is checked against hand-computed values in
-- sql/checks/delivery_attempt_parity_fixture.sql.

DO $$
DECLARE
  baseline migration_002_baseline%ROWTYPE;
  live_rows BIGINT;
  archived_rows BIGINT;
  overlap_rows BIGINT;
  summary delivery_attempt_parity_summary%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM migration_002_baseline;
  SELECT COUNT(*) INTO live_rows FROM delivery_jobs;
  SELECT COUNT(*) INTO archived_rows FROM delivery_jobs_merged_duplicates;
  SELECT COUNT(*) INTO overlap_rows
  FROM delivery_jobs_merged_duplicates d
  JOIN delivery_jobs j ON j.id = d.id;

  IF live_rows + archived_rows <> baseline.job_rows OR overlap_rows <> 0 THEN
    RAISE EXCEPTION
      'intent migration lost or duplicated rows: before %, live %, archived %, overlap %',
      baseline.job_rows, live_rows, archived_rows, overlap_rows;
  END IF;

  SELECT * INTO summary
  FROM delivery_attempt_parity_summary
  WHERE scope = 'all';

  IF COALESCE(summary.jobs_out_of_parity, 0) <> 0
     OR COALESCE(summary.legacy_attempt_total, 0) <> baseline.legacy_attempts
     OR COALESCE(summary.attempt_total, 0) <> baseline.legacy_attempts
  THEN
    RAISE EXCEPTION
      'attempt parity failed: % jobs out of parity, legacy % vs attempts % (baseline %)',
      summary.jobs_out_of_parity, summary.legacy_attempt_total,
      summary.attempt_total, baseline.legacy_attempts;
  END IF;
END
$$;

COMMIT;
