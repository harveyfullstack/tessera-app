-- Run with psql -X -v ON_ERROR_STOP=1 -f tests/sql/delivery-schema.sql in a disposable database.
\set ON_ERROR_STOP on
CREATE SCHEMA delivery_schema_test;
SET search_path TO delivery_schema_test;
\ir ../../sql/migrations/001_init_jobs.sql

INSERT INTO jobs (id, account_id, brief_id, type, metadata, status, retry_count, created_at) VALUES
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook', '{"endpointUrl":"https://original.example"}', 'failed', 8, '2026-01-01'),
  ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook', '{"endpointUrl":"https://duplicate.example"}', 'completed', 2, '2026-01-02'),
  ('00000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook', '{}', 'queued', 0, '2026-01-01');
CREATE TABLE original_jobs AS SELECT * FROM jobs;
\ir ../../sql/migrations/002_delivery_intents_and_attempts.sql

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM delivery_jobs) = 2, 'Account-scoped canonical intents';
  ASSERT (SELECT count(*) FROM jobs) = 3, 'All duplicate legacy rows survive';
  ASSERT NOT EXISTS (
    SELECT 1 FROM jobs j FULL JOIN original_jobs o USING (id)
    WHERE to_jsonb(j) - 'delivery_job_id' IS DISTINCT FROM to_jsonb(o)
  ), 'Every legacy column is preserved';
  ASSERT (SELECT count(*) FROM delivery_attempts) = 0, 'Never invent legacy history';
  ASSERT (SELECT count(*) FROM jobs WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001') = 2;
  ASSERT (SELECT metadata->>'endpointUrl' FROM delivery_jobs WHERE id = '00000000-0000-0000-0000-000000000001') = 'https://original.example';
END;
$$;

INSERT INTO jobs (id, account_id, brief_id, type) VALUES
  ('00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook'),
  ('00000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'drain_dlq');
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, worker_id, status, response_status, response_latency_ms, error_body) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'worker-a', 'failed', 503, 20, 'unavailable'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 2, 'worker-b', 'completed', 200, 10, NULL);
-- Rollback state remains writable independently of immutable history.
UPDATE jobs SET status = 'running', retry_count = retry_count + 1 WHERE id = '00000000-0000-0000-0000-000000000001';

CREATE FUNCTION expect_rejection(statement TEXT, expected_state TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_state THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'Expected % for %', expected_state, statement;
END;
$$;
SELECT expect_rejection('UPDATE delivery_jobs SET metadata = ''{}''', '55000');
SELECT expect_rejection('DELETE FROM delivery_jobs', '55000');
SELECT expect_rejection('UPDATE delivery_attempts SET error_body = ''overwritten''', '55000');
SELECT expect_rejection('DELETE FROM delivery_attempts', '55000');
SELECT expect_rejection('TRUNCATE delivery_attempts', '55000');
SELECT expect_rejection('TRUNCATE delivery_jobs CASCADE', '55000');
SELECT expect_rejection('UPDATE jobs SET delivery_job_id = ''00000000-0000-0000-0000-000000000003''', '55000');
SELECT expect_rejection('INSERT INTO delivery_jobs SELECT ''00000000-0000-0000-0000-000000000099'', account_id, brief_id, task_id, parent_job_id, type, metadata, created_at FROM delivery_jobs LIMIT 1', '23505');
SELECT expect_rejection('INSERT INTO delivery_attempts SELECT ''30000000-0000-0000-0000-000000000003'', delivery_job_id, attempt_number, worker_id, status, started_at, response_status, response_latency_ms, error_body FROM delivery_attempts LIMIT 1', '23505');
SELECT expect_rejection('INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status) VALUES (''30000000-0000-0000-0000-000000000004'', ''00000000-0000-0000-0000-000000000099'', 1, ''failed'')', '23503');

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM delivery_jobs) = 3, 'Legacy inserts map duplicates and new types';
  ASSERT (SELECT delivery_job_id FROM jobs WHERE id = '00000000-0000-0000-0000-000000000004') = '00000000-0000-0000-0000-000000000001';
  ASSERT (SELECT status FROM delivery_attempts ORDER BY attempt_number DESC LIMIT 1) = 'completed';
  ASSERT (SELECT error_body FROM delivery_attempts WHERE attempt_number = 1) = 'unavailable';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'delivery_attempts'::regclass AND contype = 'f' AND confdeltype = 'c'
  ), 'Deleting intent cannot cascade to history';
END;
$$;
\ir ../../sql/migrations/003_delivery_dlq.sql
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status, legacy_retry_count) VALUES
  ('30000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000001', 3, 'dlq', 7);
DO $$ BEGIN
  ASSERT (SELECT status FROM delivery_attempts ORDER BY attempt_number DESC LIMIT 1) = 'dlq';
  ASSERT (SELECT count(*) FROM jobs) = 5, 'DLQ migration preserves duplicate legacy jobs';
  ASSERT (SELECT legacy_retry_count FROM delivery_attempts WHERE attempt_number = 3) = 7;
  ASSERT (SELECT legacy_retry_count FROM delivery_attempts WHERE attempt_number = 1) = 0;
END; $$;
RESET search_path;
DROP SCHEMA delivery_schema_test CASCADE;
