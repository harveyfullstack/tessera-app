-- Immutable delivery intent. Unique (account_id, brief_id, type) prevents
-- duplicate-row races from replay and retry.
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, brief_id, type)
);

-- Append-only execution history. Latest-attempt reads use the DESC index.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);
