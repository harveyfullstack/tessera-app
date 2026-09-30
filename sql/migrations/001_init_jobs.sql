-- The webhook dispatcher's jobs table mixes immutable delivery intent
-- (which webhook to deliver) and mutable execution state (which attempt
-- last ran, what it returned). Each retry updates the same row;
-- there is no append-only attempt history.

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Mutable execution state on the same row.
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_account_brief_idx ON jobs (account_id, brief_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

-- No unique constraint on (brief_id, type):
-- concurrent callers can insert duplicate intent rows
-- when both lookups miss during a retry race.
