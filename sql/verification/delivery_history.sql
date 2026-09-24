-- Run in a disposable empty PostgreSQL database:
-- psql -v ON_ERROR_STOP=1 -f sql/verification/delivery_history.sql
\set ON_ERROR_STOP on
\ir ../migrations/001_init_jobs.sql

INSERT INTO jobs (id, account_id, brief_id, type, status, retry_count)
VALUES
 ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'dispatch_webhook', 'failed', 4),
 ('00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'dispatch_webhook', 'queued', 0),
 ('00000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'dispatch_webhook', 'queued', 0);

\ir ../migrations/002_delivery_history.sql

CREATE FUNCTION pg_temp.expect_rejected(statement TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    rejected := TRUE;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Expected rejection: %', statement; END IF;
END;
$$;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM jobs) = 3, 'legacy rows preserved';
  ASSERT (SELECT COUNT(*) FROM delivery_legacy_baseline) = 3, 'baseline preserves duplicates';
  ASSERT (SELECT COUNT(*) FROM delivery_jobs) = 1, 'conflicted account stays in legacy';
  ASSERT (SELECT COUNT(*) FROM delivery_attempts) = 0, 'no fabricated history';
  ASSERT (SELECT COUNT(*) FROM delivery_cutover_blockers WHERE reason = 'unresolved_history') = 3;
  ASSERT (SELECT COUNT(*) FROM delivery_cutover_blockers WHERE reason = 'duplicate_intent') = 2;
END;
$$;

SELECT pg_temp.expect_rejected('UPDATE delivery_account_rollout SET enabled = TRUE');
SELECT pg_temp.expect_rejected('UPDATE delivery_jobs SET type = ''drain_dlq''');
SELECT pg_temp.expect_rejected('DELETE FROM delivery_legacy_baseline');
SELECT pg_temp.expect_rejected('TRUNCATE delivery_legacy_baseline');
SELECT pg_temp.expect_rejected('DELETE FROM delivery_attempts');

-- A known export may resolve history. A claimed count without actual imported
-- events must still block cutover; retry_count is never used as the count.
INSERT INTO delivery_history_evidence (legacy_job_id, expected_attempt_count, evidence_source)
VALUES ('00000000-0000-0000-0000-000000000001', 1, 'verification fixture authoritative export');
SELECT pg_temp.expect_rejected('UPDATE delivery_account_rollout SET enabled = TRUE WHERE account_id = ''10000000-0000-0000-0000-000000000001''');
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status, origin)
VALUES ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 1, 'failed', 'legacy_import');
UPDATE delivery_account_rollout SET enabled = TRUE
WHERE account_id = '10000000-0000-0000-0000-000000000001';
DO $$
BEGIN
  ASSERT (SELECT matches FROM delivery_history_parity WHERE delivery_job_id = '00000000-0000-0000-0000-000000000001');
  ASSERT (SELECT rollback_until = enabled_at + INTERVAL '14 days' FROM delivery_account_rollout
          WHERE account_id = '10000000-0000-0000-0000-000000000001');
END;
$$;

-- New account: enable and exercise an independently counted live event.
INSERT INTO jobs (id, account_id, brief_id, type)
VALUES ('00000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'dispatch_webhook');
INSERT INTO delivery_jobs (id, account_id, brief_id, type, created_at)
SELECT id, account_id, brief_id, type, created_at FROM jobs WHERE id = '00000000-0000-0000-0000-000000000004';
INSERT INTO delivery_account_rollout (account_id, enabled)
VALUES ('10000000-0000-0000-0000-000000000004', TRUE);
INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status, started_at)
VALUES ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', 1, 'running', NOW());
SELECT pg_temp.expect_rejected('UPDATE delivery_account_rollout SET enabled = TRUE WHERE account_id = ''10000000-0000-0000-0000-000000000004''');
-- Rollback must work even when parity is broken.
UPDATE delivery_account_rollout SET enabled = FALSE WHERE account_id = '10000000-0000-0000-0000-000000000004';
INSERT INTO delivery_legacy_events (legacy_job_id, attempt_number, status)
VALUES ('00000000-0000-0000-0000-000000000004', 1, 'running');
UPDATE delivery_account_rollout SET enabled = TRUE WHERE account_id = '10000000-0000-0000-0000-000000000004';
SELECT pg_temp.expect_rejected('INSERT INTO delivery_attempts (id, delivery_job_id, attempt_number, status) VALUES (''30000000-0000-0000-0000-000000000005'', ''00000000-0000-0000-0000-000000000004'', 1, ''failed'')');
SELECT pg_temp.expect_rejected('UPDATE delivery_attempts SET status = ''completed''');
SELECT pg_temp.expect_rejected('TRUNCATE delivery_attempts');
SELECT pg_temp.expect_rejected('DELETE FROM delivery_jobs');
SELECT pg_temp.expect_rejected('DELETE FROM jobs WHERE id = ''00000000-0000-0000-0000-000000000004''');
DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM delivery_live_parity WHERE legacy_count <> split_count);
  ASSERT NOT EXISTS (SELECT 1 FROM delivery_live_parity_totals WHERE legacy_count <> split_count);
END;
$$;
