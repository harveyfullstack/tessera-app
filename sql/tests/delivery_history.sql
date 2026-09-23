-- Run in an empty disposable PostgreSQL database, with ON_ERROR_STOP enabled.
\ir ../migrations/001_init_jobs.sql
INSERT INTO jobs (id, account_id, brief_id, type, status, retry_count, error_message) VALUES
('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook', 'failed', 8, 'only latest error survives'),
('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'dispatch_webhook', 'queued', 0, NULL),
('00000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'dispatch_webhook', 'failed', 1, 'duplicate remains preserved');
\ir ../migrations/002_delivery_history.sql

BEGIN;
DO $$
BEGIN
  IF (SELECT count(*) FROM jobs) <> 3 OR (SELECT count(*) FROM legacy_job_snapshots) <> 3 THEN
    RAISE EXCEPTION 'Migration lost original records';
  END IF;
  IF (SELECT count(*) FROM delivery_jobs) <> 1 OR (SELECT count(*) FROM delivery_attempts) <> 0 THEN
    RAISE EXCEPTION 'Migration invented attempts or chose a duplicate winner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM legacy_job_snapshots WHERE snapshot->>'retry_count' = '8'
    AND provenance = 'legacy_snapshot_history_unknown') THEN
    RAISE EXCEPTION 'Legacy evidence was not preserved honestly';
  END IF;
  BEGIN
    PERFORM set_delivery_split('10000000-0000-0000-0000-000000000002', true);
    RAISE EXCEPTION 'Duplicate cutover was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%unresolved duplicate intents%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker-a');
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'failed', 'worker-a', 503, 20, 'upstream unavailable');
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'queued', NULL, NULL, NULL, NULL, true);
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker-b');
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'completed', 'worker-b', 200, 17);
SELECT set_delivery_split('10000000-0000-0000-0000-000000000001', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM delivery_attempt_parity WHERE legacy_count = 5 AND attempt_count = 5
    AND intent_matches AND intent_imported) THEN RAISE EXCEPTION 'Per-job parity failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM delivery_account_parity WHERE legacy_count = 5 AND attempt_count = 5 AND ready)
    THEN RAISE EXCEPTION 'Aggregate parity failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM delivery_rollouts WHERE enabled AND rollback_until >= enabled_at + INTERVAL '14 days')
    THEN RAISE EXCEPTION 'Missing rollback window'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE status = 'completed' AND retry_count = 9)
    THEN RAISE EXCEPTION 'Legacy mirror incorrect'; END IF;
  IF (SELECT max(attempt_number) FROM delivery_attempts) <> 5 THEN RAISE EXCEPTION 'Sequence incorrect'; END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO jobs (id, account_id, brief_id, type) VALUES
      ('00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
       '20000000-0000-0000-0000-000000000001', 'dispatch_webhook');
    RAISE EXCEPTION 'Enabled account accepted duplicate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%cannot create duplicate%' THEN RAISE; END IF;
  END;
END;
$$;

SELECT set_delivery_split('10000000-0000-0000-0000-000000000001', false);
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker-c');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery_rollouts WHERE enabled) OR
    NOT EXISTS (SELECT 1 FROM delivery_account_parity WHERE ready AND legacy_count = 6 AND attempt_count = 6)
    THEN RAISE EXCEPTION 'Rollback stopped history capture'; END IF;
  BEGIN
    UPDATE delivery_attempts SET status = 'cancelled';
    RAISE EXCEPTION 'Attempt history update allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM delivery_jobs;
    RAISE EXCEPTION 'Intent deletion allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE legacy_job_snapshots;
    RAISE EXCEPTION 'Snapshot truncation allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM jobs WHERE id = '00000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'Legacy rollback row deletion allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN RAISE; END IF;
  END;
END;
$$;
-- A least-privilege application role can call the boundary but not mutate
-- tables. Role creation requires an administrative disposable database user.
CREATE ROLE delivery_fixture_worker NOLOGIN;
GRANT USAGE ON SCHEMA public TO delivery_fixture_worker;
GRANT SELECT ON jobs, delivery_jobs, delivery_attempts TO delivery_fixture_worker;
GRANT EXECUTE ON FUNCTION append_delivery_attempt(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN)
  TO delivery_fixture_worker;
SET LOCAL ROLE delivery_fixture_worker;
-- Empty caller-owned temporary tables must not shadow privileged relations.
CREATE TEMP TABLE jobs (LIKE public.jobs);
CREATE TEMP TABLE delivery_attempts (LIKE public.delivery_attempts);
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'completed', 'restricted-worker', 200, 11);
DO $$
BEGIN
  BEGIN
    UPDATE public.jobs SET status = 'failed';
    RAISE EXCEPTION 'Direct application write was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM set_delivery_split('10000000-0000-0000-0000-000000000001', true);
    RAISE EXCEPTION 'Application role changed rollout';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
DROP TABLE pg_temp.jobs, pg_temp.delivery_attempts;
RESET ROLE;
SELECT append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'dlq');
DO $$
DECLARE before_count BIGINT;
BEGIN
  SELECT count(*) INTO before_count FROM delivery_attempts;
  BEGIN
    PERFORM append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running');
    RAISE EXCEPTION 'Dead-letter job restarted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%dead letter queue%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM delivery_attempts) <> before_count THEN
    RAISE EXCEPTION 'Rejected restart changed history';
  END IF;
END;
$$;
-- A bypassing legacy writer must stop the next cutover rather than hiding gaps.
UPDATE jobs SET status = 'completed' WHERE id = '00000000-0000-0000-0000-000000000001';
DO $$
BEGIN
  BEGIN
    PERFORM set_delivery_split('10000000-0000-0000-0000-000000000001', true);
    RAISE EXCEPTION 'Parity gap cutover was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%forward parity gaps%' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
