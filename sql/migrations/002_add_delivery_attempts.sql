-- Phase 2 migration: Split mutable jobs intent from append-only execution attempts.
--
-- 1. Create immutable delivery_jobs for webhook delivery intent with unique (account_id, brief_id, type).
-- 2. Migrate existing intent rows from jobs to delivery_jobs without loss or duplication.
-- 3. Create append-only delivery_attempts with delivery_job_id FK (NO CASCADE),
--    unique (delivery_job_id, attempt_number), and index (delivery_job_id, attempt_number DESC).
-- 4. Migrate existing execution history from jobs into delivery_attempts.

-- 1. Create immutable delivery_jobs table for webhook delivery intent
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_delivery_jobs_account_brief_type UNIQUE (account_id, brief_id, type)
);

CREATE INDEX IF NOT EXISTS delivery_jobs_account_brief_idx ON delivery_jobs (account_id, brief_id);

-- 2. Migrate existing intent rows from jobs into delivery_jobs.
-- In case of duplicate intent rows created by concurrent retry races in Phase 1,
-- select the canonical earliest row per (account_id, brief_id, type) to prevent duplication.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id,
  account_id,
  brief_id,
  task_id,
  parent_job_id,
  type,
  metadata,
  created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at ASC, id ASC
ON CONFLICT (account_id, brief_id, type) DO NOTHING;

-- 3. Create append-only delivery_attempts table.
-- FK does NOT use CASCADE so deleting a delivery_jobs row cannot take history with it (ON DELETE RESTRICT).
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_delivery_attempts_job_attempt UNIQUE (delivery_job_id, attempt_number)
);

-- Index for latest-attempt reads: MAX(attempt_number) or ORDER BY attempt_number DESC
CREATE INDEX IF NOT EXISTS delivery_attempts_job_attempt_desc_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- 4. Migrate existing execution history from jobs into delivery_attempts without loss.
-- Maps each job's execution state to the canonical delivery_jobs row.
-- For jobs with historical retries (retry_count > 0), generate prior failed attempts
-- followed by the current attempt state so attempt counts are preserved with parity.
DO $$
DECLARE
  rec RECORD;
  canonical_job_id UUID;
  curr_attempt INT;
  total_attempts INT;
  prior_attempt INT;
BEGIN
  FOR rec IN
    SELECT j.*
    FROM jobs j
    WHERE j.status != 'queued'
       OR j.worker_id IS NOT NULL
       OR j.started_at IS NOT NULL
       OR j.retry_count > 0
    ORDER BY j.created_at ASC, j.id ASC
  LOOP
    -- Find the canonical delivery_job_id for this intent
    SELECT id INTO canonical_job_id
    FROM delivery_jobs
    WHERE account_id = rec.account_id
      AND brief_id = rec.brief_id
      AND type = rec.type;

    IF canonical_job_id IS NOT NULL THEN
      -- Determine current max attempt number for this canonical job
      SELECT COALESCE(MAX(attempt_number), 0) INTO curr_attempt
      FROM delivery_attempts
      WHERE delivery_job_id = canonical_job_id;

      -- Calculate total attempts for this job row
      IF rec.status = 'queued' AND rec.retry_count > 0 THEN
        total_attempts := rec.retry_count;
      ELSE
        total_attempts := rec.retry_count + 1;
      END IF;

      -- Backfill prior retried attempts
      IF total_attempts > 1 THEN
        FOR prior_attempt IN 1..(total_attempts - 1) LOOP
          curr_attempt := curr_attempt + 1;
          INSERT INTO delivery_attempts (
            delivery_job_id,
            attempt_number,
            worker_id,
            status,
            error_body,
            started_at,
            completed_at,
            created_at
          ) VALUES (
            canonical_job_id,
            curr_attempt,
            rec.worker_id,
            'failed',
            'Historical attempt retried (pre-migration backfill)',
            rec.started_at,
            rec.updated_at,
            rec.created_at
          ) ON CONFLICT (delivery_job_id, attempt_number) DO NOTHING;
        END LOOP;
      END IF;

      -- Insert the latest / current attempt
      curr_attempt := curr_attempt + 1;
      INSERT INTO delivery_attempts (
        delivery_job_id,
        attempt_number,
        worker_id,
        status,
        response_status,
        response_latency_ms,
        error_body,
        started_at,
        completed_at,
        created_at
      ) VALUES (
        canonical_job_id,
        curr_attempt,
        rec.worker_id,
        rec.status,
        CASE WHEN rec.status = 'completed' THEN 200 WHEN rec.status = 'failed' THEN 500 ELSE NULL END,
        NULL,
        rec.error_message,
        rec.started_at,
        rec.completed_at,
        COALESCE(rec.updated_at, rec.created_at)
      ) ON CONFLICT (delivery_job_id, attempt_number) DO NOTHING;
    END IF;
  END LOOP;
END $$;
