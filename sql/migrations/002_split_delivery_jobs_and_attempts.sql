-- Phase 2 schema split: immutable delivery_jobs intent + delivery_attempts
-- history, append-only with a single terminal transition. One attempt row is
-- one execution: it is inserted as running and may have its outcome set
-- exactly once (running -> completed | failed | cancelled). Rows are never
-- deleted and never change after they are terminal.
--
-- The legacy jobs table is left in place and unmodified. It stays the source
-- of truth for the per-account rollback flag and for the old side of the
-- attempt-count parity comparison until the 14-day rollback bar expires.
--
-- The whole migration runs in one transaction. If the parity assertion at the
-- end fails, nothing is committed.

BEGIN;

-- Block legacy writes while intent and attempts are copied so the backfill
-- and the parity assertion see the same snapshot.
LOCK TABLE jobs IN SHARE MODE;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- delivery_jobs: immutable intent, one row per (account_id, brief_id, type)
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type)
);

CREATE FUNCTION reject_delivery_jobs_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_jobs rows are immutable (id %)', OLD.id;
END;
$$;

CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_jobs_update();

CREATE FUNCTION reject_delivery_jobs_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_jobs rows are immutable (id %)', OLD.id;
END;
$$;

CREATE TRIGGER delivery_jobs_no_delete
  BEFORE DELETE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_jobs_delete();

-- ---------------------------------------------------------------------------
-- delivery_attempts: execution history, append-only with a single terminal
-- transition
-- ---------------------------------------------------------------------------

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, never CASCADE: deleting intent must not take history with it.
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  worker_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE FUNCTION require_running_delivery_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'running' THEN
    RAISE EXCEPTION 'delivery_attempts rows must be inserted as running, not %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- Enforces uniqueness on (delivery_job_id, attempt_number) and serves
-- latest-attempt reads (ORDER BY attempt_number DESC LIMIT 1) from one index.
CREATE UNIQUE INDEX delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Rejects every DELETE. Allows exactly one UPDATE per row: running to a
-- terminal status, touching only status, response_status,
-- response_latency_ms, error_body, and completed_at.
CREATE FUNCTION guard_delivery_attempts_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivery_attempts rows cannot be deleted (id %)', OLD.id;
  END IF;

  IF OLD.status <> 'running' THEN
    RAISE EXCEPTION 'delivery_attempts row % is already terminal (%)', OLD.id, OLD.status;
  END IF;

  IF NEW.status NOT IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'delivery_attempts row % may only move from running to a terminal status, not %',
      OLD.id, NEW.status;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.delivery_job_id IS DISTINCT FROM OLD.delivery_job_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'delivery_attempts row % terminal update may only set status, response_status, response_latency_ms, error_body, and completed_at',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_attempts_single_terminal_transition
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_delivery_attempts_mutation();

-- ---------------------------------------------------------------------------
-- Legacy attempt count: how many attempts one mutable jobs row represents.
--
-- retry_count counts failed attempts that were followed by retry(). A running
-- or completed row adds its current attempt on top. A failed row has at least
-- one attempt. A cancelled row adds its attempt only if it was ever started.
-- ---------------------------------------------------------------------------

CREATE FUNCTION legacy_job_attempt_count(
  job_status TEXT,
  job_retry_count INTEGER,
  job_started_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE job_status
    WHEN 'running' THEN job_retry_count + 1
    WHEN 'completed' THEN job_retry_count + 1
    WHEN 'failed' THEN GREATEST(job_retry_count, 1)
    WHEN 'cancelled' THEN job_retry_count + CASE WHEN job_started_at IS NULL THEN 0 ELSE 1 END
    ELSE job_retry_count
  END;
$$;

-- ---------------------------------------------------------------------------
-- Backfill intent. Duplicate intent rows (from pre-migration retry races)
-- collapse onto the row the application already treats as canonical: the
-- newest by created_at, matching JobRecordService.ensureJobRecord.
-- ---------------------------------------------------------------------------

INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
SELECT
  canonical.id,
  canonical.account_id,
  canonical.brief_id,
  canonical.task_id,
  parent_canonical.id,
  canonical.type,
  canonical.metadata,
  canonical.created_at
FROM (
  SELECT DISTINCT ON (account_id, brief_id, type) *
  FROM jobs
  ORDER BY account_id, brief_id, type, created_at DESC, id DESC
) AS canonical
LEFT JOIN jobs AS parent ON parent.id = canonical.parent_job_id
LEFT JOIN LATERAL (
  SELECT j.id
  FROM jobs AS j
  WHERE j.account_id = parent.account_id
    AND j.brief_id = parent.brief_id
    AND j.type = parent.type
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT 1
) AS parent_canonical ON TRUE;

-- ---------------------------------------------------------------------------
-- Backfill attempts. The legacy row only kept its latest execution state, so
-- earlier attempts are reconstructed as failed with no response details,
-- started at the row's created_at. The latest attempt carries the row's
-- status, worker_id, error_message, started_at (falling back to created_at),
-- and completed_at. Attempts from collapsed duplicates are numbered in legacy
-- row order.
-- ---------------------------------------------------------------------------

INSERT INTO delivery_attempts (
  delivery_job_id, attempt_number, worker_id, status, error_body, started_at, completed_at
)
SELECT
  dj.id,
  ROW_NUMBER() OVER (
    PARTITION BY dj.id
    ORDER BY legacy.created_at, legacy.id, ordinal.n
  ),
  CASE WHEN ordinal.n = legacy.attempt_count THEN legacy.worker_id END,
  CASE
    WHEN ordinal.n = legacy.attempt_count AND legacy.status IN ('running', 'completed', 'failed', 'cancelled')
      THEN legacy.status
    ELSE 'failed'
  END,
  CASE WHEN ordinal.n = legacy.attempt_count THEN legacy.error_message END,
  CASE
    WHEN ordinal.n = legacy.attempt_count THEN COALESCE(legacy.started_at, legacy.created_at)
    ELSE legacy.created_at
  END,
  CASE WHEN ordinal.n = legacy.attempt_count THEN legacy.completed_at END
FROM (
  SELECT
    j.*,
    legacy_job_attempt_count(j.status, j.retry_count, j.started_at) AS attempt_count
  FROM jobs AS j
) AS legacy
JOIN delivery_jobs AS dj
  ON dj.account_id = legacy.account_id
 AND dj.brief_id = legacy.brief_id
 AND dj.type = legacy.type
CROSS JOIN LATERAL generate_series(1, legacy.attempt_count) AS ordinal(n);

CREATE TRIGGER delivery_attempts_running_insert
  BEFORE INSERT ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION require_running_delivery_attempt_insert();

-- ---------------------------------------------------------------------------
-- Parity: old vs new attempt counts per delivery job. Legacy rows map to
-- intent by (account_id, brief_id, type), so collapsed duplicates are summed.
-- Stays in place for the per-account cutover comparison.
-- ---------------------------------------------------------------------------

CREATE VIEW delivery_attempt_parity AS
SELECT
  dj.id AS delivery_job_id,
  dj.account_id,
  dj.brief_id,
  dj.type,
  COALESCE(legacy.attempt_count, 0) AS legacy_attempt_count,
  COALESCE(migrated.attempt_count, 0) AS migrated_attempt_count
FROM delivery_jobs AS dj
LEFT JOIN (
  SELECT
    account_id,
    brief_id,
    type,
    SUM(legacy_job_attempt_count(status, retry_count, started_at))::INTEGER AS attempt_count
  FROM jobs
  GROUP BY account_id, brief_id, type
) AS legacy
  ON legacy.account_id = dj.account_id
 AND legacy.brief_id = dj.brief_id
 AND legacy.type = dj.type
LEFT JOIN (
  SELECT delivery_job_id, COUNT(*)::INTEGER AS attempt_count
  FROM delivery_attempts
  GROUP BY delivery_job_id
) AS migrated
  ON migrated.delivery_job_id = dj.id;

-- Prove parity before commit: every intent key migrated, per-job counts
-- match, and aggregate counts match.
DO $$
DECLARE
  legacy_keys INTEGER;
  migrated_keys INTEGER;
  mismatched_jobs INTEGER;
  legacy_total BIGINT;
  migrated_total BIGINT;
BEGIN
  SELECT COUNT(*) INTO legacy_keys
  FROM (SELECT DISTINCT account_id, brief_id, type FROM jobs) AS keys;

  SELECT COUNT(*) INTO migrated_keys FROM delivery_jobs;

  IF legacy_keys <> migrated_keys THEN
    RAISE EXCEPTION 'delivery_jobs intent mismatch: % legacy keys, % migrated rows',
      legacy_keys, migrated_keys;
  END IF;

  SELECT COUNT(*) INTO mismatched_jobs
  FROM delivery_attempt_parity
  WHERE legacy_attempt_count <> migrated_attempt_count;

  IF mismatched_jobs > 0 THEN
    RAISE EXCEPTION 'delivery_attempts parity failed for % delivery job(s)', mismatched_jobs;
  END IF;

  SELECT COALESCE(SUM(legacy_job_attempt_count(status, retry_count, started_at)), 0)
  INTO legacy_total
  FROM jobs;

  SELECT COUNT(*) INTO migrated_total FROM delivery_attempts;

  IF legacy_total <> migrated_total THEN
    RAISE EXCEPTION 'delivery_attempts aggregate parity failed: % legacy, % migrated',
      legacy_total, migrated_total;
  END IF;
END;
$$;

COMMIT;
