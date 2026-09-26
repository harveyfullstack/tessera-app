-- Phase 2 webhook delivery hardening: keep delivery intent immutable and
-- record every execution as append-only attempt history.

ALTER TABLE jobs RENAME TO delivery_jobs;

ALTER TABLE delivery_jobs
  ADD CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
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

  CONSTRAINT delivery_attempts_job_attempt_key UNIQUE (delivery_job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_latest_idx
  ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Backfill one synthetic attempt for every pre-split job row that already had
-- execution state. This preserves parity during cutover: every legacy job with
-- a terminal/current status has exactly one attempt row before new attempts are
-- appended through the RPC write boundary.
INSERT INTO delivery_attempts (
  id,
  delivery_job_id,
  attempt_number,
  worker_id,
  status,
  error_body,
  started_at,
  completed_at,
  created_at
)
SELECT
  gen_random_uuid(),
  id,
  GREATEST(retry_count + 1, 1),
  worker_id,
  status,
  error_message,
  started_at,
  completed_at,
  updated_at
FROM delivery_jobs
WHERE status <> 'queued'
ON CONFLICT (delivery_job_id, attempt_number) DO NOTHING;

-- Parity check helpers for rollout validation. Per-job parity should remain
-- within one synthetic attempt before the RPC boundary starts writing true
-- append-only attempts; aggregate parity lets the rollout compare cohort counts.
CREATE OR REPLACE VIEW delivery_attempt_parity AS
SELECT
  j.id AS delivery_job_id,
  j.account_id,
  j.brief_id,
  j.type,
  GREATEST(j.retry_count + CASE WHEN j.status = 'queued' THEN 0 ELSE 1 END, 0) AS legacy_attempt_count,
  COUNT(a.id) AS split_attempt_count
FROM delivery_jobs j
LEFT JOIN delivery_attempts a ON a.delivery_job_id = j.id
GROUP BY j.id, j.account_id, j.brief_id, j.type, j.retry_count, j.status;
