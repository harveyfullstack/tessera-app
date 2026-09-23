-- Fixture for migration 002 (TESSERA-1880). It checks the legacy attempt
-- count and the attempt backfill against hand-computed values.
--
-- Run it only against an empty scratch database. It applies migrations 001
-- and 002 itself:
--   psql -v ON_ERROR_STOP=1 -d <scratch_db> -f sql/checks/delivery_attempt_parity_fixture.sql
--
-- Seed rows follow DeliveryOrchestrator.deliver: markRunning, then on failure
-- retry() (retry_count + 1) and markFailed. markFailed sets updated_at and
-- completed_at to the same instant.

\set ON_ERROR_STOP on
\ir ../migrations/001_init_jobs.sql

INSERT INTO jobs (
  id, account_id, brief_id, type, parent_job_id, status, worker_id,
  retry_count, error_message, started_at, completed_at, created_at, updated_at
) VALUES
  -- acct 1: A completed on its first run. Expected 1 run.
  ('00000000-0000-4000-a000-00000000000a', '11111111-1111-4111-a111-111111111111',
   'b0000000-0000-4000-a000-00000000000a', 'dispatch_webhook', NULL, 'completed', 'w-a',
   0, NULL, '2026-01-01 10:00', '2026-01-01 10:01', '2026-01-01 09:00', '2026-01-01 10:01'),
  -- acct 1: B failed once (retry_count 1, updated_at = completed_at). Expected 1.
  ('00000000-0000-4000-a000-00000000000b', '11111111-1111-4111-a111-111111111111',
   'b0000000-0000-4000-a000-00000000000b', 'dispatch_webhook', NULL, 'failed', 'w-b',
   1, 'Simulated webhook delivery failure', '2026-01-01 10:00', '2026-01-01 10:01',
   '2026-01-01 09:00', '2026-01-01 10:01'),
  -- acct 1: C completed after 2 failed runs. Expected 3.
  ('00000000-0000-4000-a000-00000000000c', '11111111-1111-4111-a111-111111111111',
   'b0000000-0000-4000-a000-00000000000c', 'dispatch_webhook', NULL, 'completed', 'w-c',
   2, NULL, '2026-01-01 10:20', '2026-01-01 10:21', '2026-01-01 09:00', '2026-01-01 10:21'),
  -- acct 2: F running on its 3rd run after 2 failures. Expected 3.
  ('00000000-0000-4000-a000-00000000000f', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-00000000000f', 'dispatch_webhook', NULL, 'running', 'w-f',
   2, NULL, '2026-01-01 10:20', '2026-01-01 10:11', '2026-01-01 09:00', '2026-01-01 10:20'),
  -- acct 2: G failed on all 3 runs. Expected 3.
  ('00000000-0000-4000-a000-000000000009', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-000000000009', 'dispatch_webhook', NULL, 'failed', 'w-g',
   3, 'Simulated webhook delivery failure', '2026-01-01 10:20', '2026-01-01 10:21',
   '2026-01-01 09:00', '2026-01-01 10:21'),
  -- acct 2: D queued and never run. Expected 0.
  ('00000000-0000-4000-a000-00000000000d', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-00000000000d', 'dispatch_webhook', NULL, 'queued', NULL,
   0, NULL, NULL, NULL, '2026-01-01 09:00', '2026-01-01 09:00'),
  -- acct 2: H failed with retry_count 0 (markFailed without retry, a path no
  -- production caller uses). Its one run still counts. Expected 1.
  ('00000000-0000-4000-a000-000000000008', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-000000000008', 'dispatch_webhook', NULL, 'failed', 'w-h',
   0, 'direct markFailed', '2026-01-01 10:00', '2026-01-01 10:01',
   '2026-01-01 09:00', '2026-01-01 10:01'),
  -- acct 2: E1 and E2 are duplicate intent rows from an ensureJobRecord race.
  -- E1 is canonical because it has the earlier created_at. E1 failed once
  -- (1 run) and E2 completed first try (1 run), so E1 is expected to have 2.
  ('00000000-0000-4000-a000-0000000000e1', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-00000000000e', 'dispatch_webhook', NULL, 'failed', 'w-e1',
   1, 'Simulated webhook delivery failure', '2026-01-01 10:00', '2026-01-01 10:01',
   '2026-01-01 09:00', '2026-01-01 10:01'),
  ('00000000-0000-4000-a000-0000000000e2', '22222222-2222-4222-a222-222222222222',
   'b0000000-0000-4000-a000-00000000000e', 'dispatch_webhook', NULL, 'completed', 'w-e2',
   0, NULL, '2026-01-01 10:00', '2026-01-01 10:01', '2026-01-01 09:00:01', '2026-01-01 10:01');

-- E3 is a queued child of duplicate E2. Its parent must be repointed to E1.
-- Expected 0 runs.
INSERT INTO jobs (id, account_id, brief_id, type, parent_job_id, created_at, updated_at)
VALUES ('00000000-0000-4000-a000-0000000000e3', '22222222-2222-4222-a222-222222222222',
        'b0000000-0000-4000-a000-00000000000e', 'drain_dlq',
        '00000000-0000-4000-a000-0000000000e2', '2026-01-01 09:00', '2026-01-01 09:00');

\ir ../migrations/002_split_delivery_jobs_and_attempts.sql

-- Hand-computed expectations. R = running, F = failed, C = completed.
CREATE TEMP TABLE expected (
  delivery_job_id UUID PRIMARY KEY,
  runs INTEGER NOT NULL,
  sequence TEXT NOT NULL
);

INSERT INTO expected VALUES
  ('00000000-0000-4000-a000-00000000000a', 1, 'R C'),
  ('00000000-0000-4000-a000-00000000000b', 1, 'R F'),
  ('00000000-0000-4000-a000-00000000000c', 3, 'R F R F R C'),
  ('00000000-0000-4000-a000-00000000000f', 3, 'R F R F R'),
  ('00000000-0000-4000-a000-000000000009', 3, 'R F R F R F'),
  ('00000000-0000-4000-a000-00000000000d', 0, ''),
  ('00000000-0000-4000-a000-000000000008', 1, 'R F'),
  ('00000000-0000-4000-a000-0000000000e1', 2, 'R F R C'),
  ('00000000-0000-4000-a000-0000000000e3', 0, '');

DO $$
DECLARE
  mismatch RECORD;
  total RECORD;
BEGIN
  -- Per job: the legacy count, the backfilled runs and the attempt sequence.
  FOR mismatch IN
    SELECT e.delivery_job_id, e.runs, e.sequence,
           p.legacy_attempt_count, p.attempt_count, s.actual_sequence
    FROM expected e
    FULL JOIN delivery_attempt_parity p ON p.delivery_job_id = e.delivery_job_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(string_agg(upper(left(a.status, 1)), ' '
               ORDER BY a.attempt_number), '') AS actual_sequence
      FROM delivery_attempts a
      WHERE a.delivery_job_id = COALESCE(e.delivery_job_id, p.delivery_job_id)
    ) s ON TRUE
    WHERE e.delivery_job_id IS NULL
       OR p.delivery_job_id IS NULL
       OR p.legacy_attempt_count IS DISTINCT FROM e.runs
       OR p.attempt_count IS DISTINCT FROM e.runs
       OR s.actual_sequence IS DISTINCT FROM e.sequence
  LOOP
    RAISE EXCEPTION
      'job %: expected % runs [%], got legacy % / attempts % [%]',
      mismatch.delivery_job_id, mismatch.runs, mismatch.sequence,
      mismatch.legacy_attempt_count, mismatch.attempt_count,
      mismatch.actual_sequence;
  END LOOP;

  -- Per account and in total: acct 1 = 1+1+3 = 5, acct 2 = 3+3+0+1+2+0 = 9.
  FOR total IN
    SELECT want.scope, want.account_id, want.runs,
           s.legacy_attempt_total, s.attempt_total
    FROM (VALUES
      ('all', NULL::UUID, 14),
      ('account', '11111111-1111-4111-a111-111111111111'::UUID, 5),
      ('account', '22222222-2222-4222-a222-222222222222'::UUID, 9)
    ) AS want(scope, account_id, runs)
    LEFT JOIN delivery_attempt_parity_summary s
      ON s.scope = want.scope
     AND s.account_id IS NOT DISTINCT FROM want.account_id
    WHERE s.scope IS NULL
       OR s.legacy_attempt_total <> want.runs
       OR s.attempt_total <> want.runs
       OR NOT s.in_parity
  LOOP
    RAISE EXCEPTION 'summary % %: expected % runs, got legacy % / attempts %',
      total.scope, total.account_id, total.runs,
      total.legacy_attempt_total, total.attempt_total;
  END LOOP;

  -- Duplicate merge: E2 archived under E1, child E3 repointed.
  IF NOT EXISTS (
    SELECT 1 FROM delivery_jobs_merged_duplicates
    WHERE id = '00000000-0000-4000-a000-0000000000e2'
      AND canonical_job_id = '00000000-0000-4000-a000-0000000000e1'
  ) OR (SELECT parent_job_id FROM delivery_jobs
        WHERE id = '00000000-0000-4000-a000-0000000000e3')
       IS DISTINCT FROM '00000000-0000-4000-a000-0000000000e1'::UUID
  THEN
    RAISE EXCEPTION 'duplicate intent merge did not archive E2 under E1 or repoint E3';
  END IF;

  RAISE NOTICE 'delivery_attempt parity fixture passed';
END
$$;
