-- Keep jobs and its mutable status for the 14-day per-account rollback window.
-- Run after 001_init_jobs.sql, before enabling the split for any account.
CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  type TEXT NOT NULL,
  task_id UUID,
  parent_job_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_jobs_intent_key UNIQUE (account_id, brief_id, type)
);

-- Pick the oldest row as the canonical intent; keep every legacy jobs row.
INSERT INTO delivery_jobs (id, account_id, brief_id, type, task_id, parent_job_id, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id, account_id, brief_id, type, task_id, parent_job_id, metadata, created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at, id;

ALTER TABLE jobs ADD COLUMN delivery_job_id UUID REFERENCES delivery_jobs(id) ON DELETE RESTRICT;
UPDATE jobs AS j
SET delivery_job_id = d.id
FROM delivery_jobs AS d
WHERE j.account_id = d.account_id AND j.brief_id = d.brief_id AND j.type = d.type;
ALTER TABLE jobs ALTER COLUMN delivery_job_id SET NOT NULL;
CREATE INDEX jobs_delivery_job_idx ON jobs (delivery_job_id);

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_number_key UNIQUE (delivery_job_id, attempt_number)
);
CREATE INDEX delivery_attempts_latest_idx ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- New history starts at cutover. retry_count is the only available legacy signal;
-- historical attempt bodies cannot be reconstructed from jobs.
CREATE FUNCTION reject_delivery_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery intent and attempts are immutable';
END;
$$;
CREATE TRIGGER immutable_delivery_jobs BEFORE UPDATE OR DELETE ON delivery_jobs
FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER immutable_delivery_attempts BEFORE UPDATE OR DELETE ON delivery_attempts
FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();
