-- Keep the original mutable rows as a rollback/archive source. Historical attempts
-- overwritten by the old jobs table cannot be reconstructed from retry_count.
BEGIN;
ALTER TABLE jobs RENAME TO legacy_jobs;

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id),
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_jobs_intent_unique UNIQUE (account_id, brief_id, type)
);

-- Every old row stays in legacy_jobs, including duplicates. The oldest row
-- becomes the canonical intent; the mapping retains each old row's identity.
CREATE TABLE legacy_job_mapping (
  legacy_job_id UUID PRIMARY KEY REFERENCES legacy_jobs(id),
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id),
  historical_attempts_unknown INTEGER NOT NULL CHECK (historical_attempts_unknown >= 0)
);

INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, type, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id, account_id, brief_id, task_id, type, metadata, created_at
FROM legacy_jobs
ORDER BY account_id, brief_id, type, created_at, id;

INSERT INTO legacy_job_mapping (legacy_job_id, delivery_job_id, historical_attempts_unknown)
SELECT l.id, d.id,
  l.retry_count
FROM legacy_jobs l
JOIN delivery_jobs d USING (account_id, brief_id, type);

-- Point canonical parent links at canonical parents, even when the old parent
-- was one of the archived duplicate rows.
UPDATE delivery_jobs d
SET parent_job_id = parent.delivery_job_id
FROM legacy_jobs l
JOIN legacy_job_mapping parent ON parent.legacy_job_id = l.parent_job_id
WHERE l.id = d.id;

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  response_status INTEGER,
  response_latency_ms INTEGER,
  error_body TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_attempts_number_unique UNIQUE (delivery_job_id, attempt_number)
);
CREATE INDEX delivery_attempts_latest_idx ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- Backfill only the latest observable execution per intent. Duplicate legacy
-- executions are distinct attempts; retry_count is NOT invented as history.
WITH observable AS (
  SELECT l.id, m.delivery_job_id, l.worker_id, l.status, l.error_message,
    l.started_at, l.completed_at, l.updated_at,
    ROW_NUMBER() OVER (PARTITION BY m.delivery_job_id ORDER BY l.created_at, l.id) AS attempt_number
  FROM legacy_jobs l
  JOIN legacy_job_mapping m ON m.legacy_job_id = l.id
  WHERE l.status <> 'queued'
)
INSERT INTO delivery_attempts
  (id, delivery_job_id, attempt_number, worker_id, status, error_body, started_at, completed_at, created_at)
SELECT id, delivery_job_id, attempt_number, worker_id, status, error_message,
  COALESCE(started_at, updated_at), completed_at, updated_at
FROM observable;

-- Abort cutover if any archived row lacks a mapping or an observable execution
-- lacks its backfilled attempt. Unknown historical attempts remain explicitly
-- quantified in legacy_job_mapping; they cannot be claimed as parity.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM legacy_jobs l LEFT JOIN legacy_job_mapping m ON m.legacy_job_id = l.id WHERE m.legacy_job_id IS NULL)
    OR EXISTS (
      SELECT 1 FROM delivery_jobs d
      WHERE (SELECT COUNT(*) FROM legacy_jobs l JOIN legacy_job_mapping m ON m.legacy_job_id = l.id
             WHERE m.delivery_job_id = d.id AND l.status <> 'queued')
          <> (SELECT COUNT(*) FROM delivery_attempts a WHERE a.delivery_job_id = d.id)
    ) THEN
    RAISE EXCEPTION 'delivery migration observable-count parity failed';
  END IF;
END $$;
COMMIT;

-- Audit per intent (and sum these columns for aggregate parity). An unknown
-- count > 0 indicates historical executions the legacy schema already lost.
CREATE VIEW delivery_attempt_migration_parity AS
SELECT d.id AS delivery_job_id,
  COUNT(l.id) FILTER (WHERE l.status <> 'queued') AS observable_legacy_attempts,
  (SELECT COUNT(*) FROM delivery_attempts a WHERE a.delivery_job_id = d.id) AS backfilled_attempts,
  COALESCE(SUM(m.historical_attempts_unknown), 0) AS historical_attempts_unknown
FROM delivery_jobs d
LEFT JOIN legacy_job_mapping m ON m.delivery_job_id = d.id
LEFT JOIN legacy_jobs l ON l.id = m.legacy_job_id
GROUP BY d.id;
