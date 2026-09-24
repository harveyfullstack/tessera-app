\set ON_ERROR_STOP on
\ir delivery_rpc.sql
\ir ../migrations/004_delivery_status.sql

UPDATE delivery_account_rollout SET enabled = TRUE WHERE account_id = '10000000-0000-0000-0000-000000000001';
SELECT public.append_delivery_attempt('00000000-0000-0000-0000-000000000001', 'running', 'slow-worker');
DO $$
DECLARE started TIMESTAMPTZ;
BEGIN
  SELECT started_at INTO started FROM delivery_attempts
  WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001' ORDER BY attempt_number DESC LIMIT 1;
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000001', started + INTERVAL '5 minutes') = 'running';
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000001', started + INTERVAL '5 minutes 1 millisecond') = 'stuck';
  UPDATE delivery_account_rollout SET enabled = FALSE WHERE account_id = '10000000-0000-0000-0000-000000000001';
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000001', started + INTERVAL '1 hour') = 'running';
END;
$$;

INSERT INTO jobs (id, account_id, brief_id, type)
VALUES ('00000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005', 'dispatch_webhook');
INSERT INTO delivery_jobs (id, account_id, brief_id, type, created_at)
SELECT id, account_id, brief_id, type, created_at FROM jobs WHERE id = '00000000-0000-0000-0000-000000000005';
INSERT INTO delivery_account_rollout (account_id, enabled)
VALUES ('10000000-0000-0000-0000-000000000005', TRUE);
DO $$ BEGIN
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000005') = 'queued';
END; $$;

-- Deliberately out of timestamp and insertion order: max(number) must win.
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status, created_at)
VALUES
 ('30000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000005', 20, 'failed', '2020-01-01'),
 ('30000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000005', 10, 'completed', '2021-01-01');
INSERT INTO delivery_legacy_events (legacy_job_id, attempt_number, status)
VALUES ('00000000-0000-0000-0000-000000000005', 20, 'failed'),
       ('00000000-0000-0000-0000-000000000005', 10, 'completed');
DO $$ BEGIN
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000005') = 'failed';
END; $$;
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status, started_at)
VALUES ('30000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000005', 21, 'running', NULL);
DO $$ BEGIN
  ASSERT public.delivery_display_status('00000000-0000-0000-0000-000000000005') = 'running';
END; $$;
