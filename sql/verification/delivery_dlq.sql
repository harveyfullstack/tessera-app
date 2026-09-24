\set ON_ERROR_STOP on
\ir delivery_status.sql
\ir ../migrations/005_delivery_dlq.sql

INSERT INTO public.delivery_retry_budgets VALUES ('10000000-0000-0000-0000-000000000001', 3);
-- Explicit replay starts a fresh failure budget without removing old history.
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'queued', NULL, NULL, NULL, NULL, NULL, TRUE);
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'failed', NULL, 503, 10, 'body-1', 'failed', TRUE);
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'failed', NULL, 503, 10, 'body-2', 'failed', TRUE);
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM delivery_dead_letters WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001');
END; $$;
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'worker');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'failed', NULL, 503, 10, 'body-3', 'failed', TRUE);
SELECT public.drain_delivery_dlq('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
SELECT public.drain_delivery_dlq('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_rejected($q$SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'blocked-worker')$q$);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM delivery_dead_letters WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001') = 1;
  ASSERT (SELECT failed_attempt_count = 3 AND last_attempt_bodies = '["body-3","body-2","body-1"]'::jsonb
          FROM delivery_dlq_summary WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001');
END; $$;
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'queued', NULL, NULL, NULL, NULL, NULL, TRUE);
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'replay-worker');
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'completed', NULL, 200, 15);
DO $$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM delivery_dead_letters WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001');
  ASSERT public.delivery_failure_count('00000000-0000-0000-0000-000000000001') = 0;
  ASSERT (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001' AND status = 'failed') >= 5;
END; $$;
