-- Run in an empty disposable database; includes schema and migration checks.
\set ON_ERROR_STOP on
\ir delivery_history.sql
\ir ../migrations/003_delivery_attempt_rpc.sql

SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker-one');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'failed', NULL, 503, 30000, 'endpoint timeout', 'delivery failed');
UPDATE delivery_account_rollout SET enabled = FALSE WHERE account_id = '10000000-0000-0000-0000-000000000001';
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'queued', NULL, NULL, NULL, NULL, NULL, TRUE);
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker-two');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'completed', NULL, 200, 42);
-- Conflicted account has no immutable intent, but complete events still survive.
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000002', 'running', 'legacy-worker');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000002', 'failed', NULL, 502, 17, 'legacy response body', 'bad gateway');
SELECT pg_temp.expect_rejected($q$SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'invalid')$q$);
SELECT pg_temp.expect_rejected($q$SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'completed', NULL, 999)$q$);
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001') = 6;
  ASSERT (SELECT COUNT(*) FROM delivery_legacy_events WHERE legacy_job_id = '00000000-0000-0000-0000-000000000001') = 5;
  ASSERT (SELECT worker_id = 'worker-one' AND response_status = 503 AND error_body = 'endpoint timeout'
          AND started_at IS NOT NULL AND completed_at IS NOT NULL FROM delivery_attempts
          WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001' AND attempt_number = 3);
  ASSERT (SELECT status = 'completed' AND worker_id = 'worker-two' AND retry_count = 5
          FROM jobs WHERE id = '00000000-0000-0000-0000-000000000001');
  ASSERT (SELECT response_status = 502 AND response_latency_ms = 17 AND error_body = 'legacy response body'
          AND worker_id = 'legacy-worker' AND completed_at IS NOT NULL
          FROM delivery_legacy_events WHERE legacy_job_id = '00000000-0000-0000-0000-000000000002' AND attempt_number = 2);
  ASSERT NOT EXISTS (SELECT 1 FROM delivery_live_parity WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001' AND legacy_count <> split_count);
END;
$$;
