-- Canonical post-migration schema. delivery_jobs holds immutable delivery
-- intent; delivery_attempts is append-only execution history.

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs (id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Legacy/rollback columns. Execution truth lives on delivery_attempts.
  status TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT delivery_jobs_account_brief_type_uidx UNIQUE (account_id, brief_id, type)
);

CREATE INDEX IF NOT EXISTS delivery_jobs_account_brief_idx
  ON delivery_jobs (account_id, brief_id);
CREATE INDEX IF NOT EXISTS delivery_jobs_status_idx
  ON delivery_jobs (status);

-- No ON DELETE CASCADE: deleting a delivery_jobs row must not drop history.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs (id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_job_number_uidx UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

CREATE OR REPLACE VIEW jobs AS
SELECT * FROM delivery_jobs;
