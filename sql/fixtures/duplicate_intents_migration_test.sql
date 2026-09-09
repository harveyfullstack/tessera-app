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
END $$;

ROLLBACK;
