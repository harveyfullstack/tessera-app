-- Pre-migration schema. The webhook dispatcher's jobs table mixes immutable
-- intent (which webhook to deliver) and mutable execution state (which attempt
-- last ran, what it returned). The follow-up brief splits these into
-- delivery_jobs (intent) + delivery_attempts (append-only history).

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Mutable execution state on the same row. Target of the migration brief.
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

-- Intentionally no unique constraint on (brief_id, type) yet. Duplicate intent
-- rows surface during retry races. The follow-up brief adds the constraint
-- and routes all execution writes through an RPC boundary.
