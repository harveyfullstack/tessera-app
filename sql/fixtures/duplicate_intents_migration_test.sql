-- Isolated fixture for validating 002 duplicate-intent reconciliation.
-- Apply against a throwaway database; does not touch application tables.

BEGIN;

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO jobs (
  id,
  account_id,
  brief_id,
  type,
  metadata,
  status,
  retry_count,
  error_message,
  updated_at
) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'dispatch_webhook', '{}'::jsonb, 'failed', 2, 'older duplicate', NOW() - INTERVAL '2 hours'),
  ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'dispatch_webhook', '{}'::jsonb, 'failed', 3, 'canonical duplicate', NOW() - INTERVAL '1 hour'),
  ('33333333-3333-3333-3333-333333333333', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'dispatch_webhook', '{}'::jsonb, 'completed', 1, NULL, NOW());

-- Lifecycle boundary cases: jobs with prior retries that are NOT terminally
-- 'completed' or 'failed'. Each must preserve every prior failed execution
-- plus its own current-state row (queued IS a tracked attempt status: it
-- gets its own row too, unless the job is fresh with zero history).
INSERT INTO jobs (
  id,
  account_id,
  brief_id,
  type,
  metadata,
  status,
  retry_count,
  error_message,
  updated_at
) VALUES
  -- running with 2 prior failures: must backfill 2 failed + 1 running (not 2 total).
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'dispatch_webhook', '{}'::jsonb, 'running', 2, NULL, NOW()),
  -- cancelled with 1 prior failure: must backfill 1 failed + 1 cancelled (not 1 total).
  ('55555555-5555-5555-5555-555555555555', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'dispatch_webhook', '{}'::jsonb, 'cancelled', 1, 'operator cancelled', NOW()),
  -- requeued with 2 prior failures, waiting to run again: must backfill 2 failed + 1 queued (not 2 total).
  ('66666666-6666-6666-6666-666666666666', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'dispatch_webhook', '{}'::jsonb, 'queued', 2, 'last retry failure', NOW()),
  -- fresh queued, never attempted: must backfill zero attempts.
  ('77777777-7777-7777-7777-777777777777', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '99999999-9999-9999-9999-999999999999', 'dispatch_webhook', '{}'::jsonb, 'queued', 0, NULL, NOW()),
  -- failed immediately with no retries: must still backfill one failed row,
  -- not zero (retry_count=0 does not mean "never executed" for a terminal
  -- failure the way it does for queued).
  ('88888888-8888-8888-8888-888888888888', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '88888888-8888-8888-8888-888888888888', 'dispatch_webhook', '{}'::jsonb, 'failed', 0, 'failed on first attempt', NOW());

\i ../migrations/002_delivery_jobs_and_attempts.sql

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM delivery_jobs_duplicate_intents) <> 1 THEN
    RAISE EXCEPTION 'expected one archived duplicate intent row';
  END IF;

  IF (SELECT COUNT(*) FROM delivery_jobs WHERE brief_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') <> 1 THEN
    RAISE EXCEPTION 'expected one canonical delivery job after reconciliation';
  END IF;

  IF (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '22222222-2222-2222-2222-222222222222') <> 3 THEN
    RAISE EXCEPTION 'expected three backfilled terminal attempts for retry_count=3';
  END IF;

  -- running with retry_count=2: 2 prior failures must survive alongside the
  -- current running row, not collapse into it.
  IF (SELECT array_agg(status ORDER BY attempt_number) FROM delivery_attempts WHERE delivery_job_id = '44444444-4444-4444-4444-444444444444') <> ARRAY['failed', 'failed', 'running']::text[] THEN
    RAISE EXCEPTION 'expected 2 preserved failures then a running row for retry_count=2 running job';
  END IF;

  IF (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '44444444-4444-4444-4444-444444444444' AND status = 'failed') <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 logical failed executions for retry_count=2 running job';
  END IF;

  -- cancelled with retry_count=1: the 1 prior failure must survive alongside
  -- the current cancelled row, not collapse into it.
  IF (SELECT array_agg(status ORDER BY attempt_number) FROM delivery_attempts WHERE delivery_job_id = '55555555-5555-5555-5555-555555555555') <> ARRAY['failed', 'cancelled']::text[] THEN
    RAISE EXCEPTION 'expected 1 preserved failure then a cancelled row for retry_count=1 cancelled job';
  END IF;

  -- requeued with retry_count=2: both prior failures must survive alongside
  -- the current queued row, not collapse into it.
  IF (SELECT array_agg(status ORDER BY attempt_number) FROM delivery_attempts WHERE delivery_job_id = '66666666-6666-6666-6666-666666666666') <> ARRAY['failed', 'failed', 'queued']::text[] THEN
    RAISE EXCEPTION 'expected 2 preserved failures then a queued row for retry_count=2 queued job';
  END IF;

  IF (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '66666666-6666-6666-6666-666666666666' AND status = 'failed') <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 logical failed executions for retry_count=2 queued job';
  END IF;

  -- fresh queued job with retry_count=0: no attempt history to backfill.
  IF (SELECT COUNT(*) FROM delivery_attempts WHERE delivery_job_id = '77777777-7777-7777-7777-777777777777') <> 0 THEN
    RAISE EXCEPTION 'expected zero backfilled attempts for a fresh queued job';
  END IF;

  -- failed with retry_count=0: one known failed execution must survive as
  -- exactly one row, not be floored to zero.
  IF (SELECT array_agg(status ORDER BY attempt_number) FROM delivery_attempts WHERE delivery_job_id = '88888888-8888-8888-8888-888888888888') <> ARRAY['failed']::text[] THEN
    RAISE EXCEPTION 'expected exactly one failed row for retry_count=0 failed job';
  END IF;
END $$;

ROLLBACK;
