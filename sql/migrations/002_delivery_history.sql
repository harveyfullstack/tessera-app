BEGIN;

-- Keep the Phase 1 table writable for rollback. This snapshot is the immutable
-- migration baseline, not reconstructed attempt history.
LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE;
CREATE TABLE delivery_legacy_baseline AS TABLE jobs;
ALTER TABLE delivery_legacy_baseline ADD PRIMARY KEY (id);

CREATE FUNCTION reject_delivery_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER delivery_legacy_baseline_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_legacy_baseline
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER delivery_legacy_baseline_closed
BEFORE INSERT ON delivery_legacy_baseline
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, brief_id, type)
);

-- Leave an entire conflicted account in Phase 1. Never silently choose one of
-- two intents or strand a parent reference by migrating only half an account.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
SELECT id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at
FROM jobs j
WHERE NOT EXISTS (
  SELECT 1 FROM jobs duplicates
  WHERE duplicates.account_id = j.account_id
  GROUP BY duplicates.brief_id, duplicates.type HAVING COUNT(*) > 1
)
AND NOT EXISTS (
  SELECT 1 FROM jobs child JOIN jobs parent ON parent.id = child.parent_job_id
  WHERE child.account_id = j.account_id AND parent.account_id <> child.account_id
);

CREATE TRIGGER delivery_jobs_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_jobs
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('legacy_import', 'live')),
  UNIQUE (delivery_job_id, attempt_number)
);
CREATE INDEX delivery_attempts_latest_idx ON delivery_attempts (delivery_job_id, attempt_number DESC);
CREATE TRIGGER delivery_attempts_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_attempts
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

-- The execution RPC writes this compatibility ledger and updates jobs in the
-- same transaction as the new event. Count the two persisted paths separately.
CREATE TABLE delivery_legacy_events (
  legacy_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (legacy_job_id, attempt_number)
);
CREATE TRIGGER delivery_legacy_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_legacy_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE VIEW delivery_live_parity AS
SELECT j.account_id, j.id AS delivery_job_id,
       (SELECT COUNT(*) FROM delivery_legacy_events e WHERE e.legacy_job_id = j.id) AS legacy_count,
       (SELECT COUNT(*) FROM delivery_attempts a WHERE a.delivery_job_id = j.id AND a.origin = 'live') AS split_count
FROM jobs j;

CREATE VIEW delivery_live_parity_totals AS
SELECT account_id, SUM(legacy_count) AS legacy_count, SUM(split_count) AS split_count
FROM delivery_live_parity GROUP BY account_id;

-- An operator may record a count only from an authoritative export. An absent
-- row means unknown, never zero. The migration deliberately inserts no rows.
CREATE TABLE delivery_history_evidence (
  legacy_job_id UUID PRIMARY KEY REFERENCES delivery_legacy_baseline(id) ON DELETE RESTRICT,
  expected_attempt_count INTEGER NOT NULL CHECK (expected_attempt_count >= 0),
  evidence_source TEXT NOT NULL CHECK (LENGTH(BTRIM(evidence_source)) > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW delivery_history_parity AS
SELECT b.account_id, b.id AS delivery_job_id,
       e.expected_attempt_count,
       COUNT(a.id) AS imported_attempt_count,
       e.legacy_job_id IS NOT NULL AND e.expected_attempt_count = COUNT(a.id) AS matches
FROM delivery_legacy_baseline b
LEFT JOIN delivery_history_evidence e ON e.legacy_job_id = b.id
LEFT JOIN delivery_attempts a ON a.delivery_job_id = b.id AND a.origin = 'legacy_import'
GROUP BY b.account_id, b.id, e.legacy_job_id, e.expected_attempt_count;

CREATE VIEW delivery_history_parity_totals AS
SELECT account_id, SUM(expected_attempt_count) AS expected_attempt_count,
       SUM(imported_attempt_count) AS imported_attempt_count, BOOL_AND(matches) AS matches
FROM delivery_history_parity GROUP BY account_id;

CREATE VIEW delivery_cutover_blockers AS
SELECT account_id, id AS delivery_job_id, 'unresolved_history'::TEXT AS reason
FROM delivery_legacy_baseline b
WHERE NOT EXISTS (SELECT 1 FROM delivery_history_evidence e WHERE e.legacy_job_id = b.id)
UNION ALL
SELECT account_id, delivery_job_id, 'historical_count_mismatch'
FROM delivery_history_parity WHERE expected_attempt_count IS NOT NULL AND NOT matches
UNION ALL
SELECT account_id, NULL::UUID, 'aggregate_history_mismatch'
FROM delivery_history_parity_totals WHERE NOT matches
UNION ALL
SELECT j.account_id, j.id, 'missing_or_changed_intent'
FROM jobs j LEFT JOIN delivery_jobs d ON d.id = j.id
WHERE d.id IS NULL OR ROW(j.account_id, j.brief_id, j.task_id, j.parent_job_id, j.type, j.metadata, j.created_at)
  IS DISTINCT FROM ROW(d.account_id, d.brief_id, d.task_id, d.parent_job_id, d.type, d.metadata, d.created_at)
UNION ALL
SELECT b.account_id, b.id, 'missing_legacy_row'
FROM delivery_legacy_baseline b WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = b.id)
UNION ALL
SELECT d.account_id, d.id, 'missing_rollback_intent'
FROM delivery_jobs d WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = d.id)
UNION ALL
SELECT j.account_id, j.id, 'duplicate_intent'
FROM jobs j WHERE EXISTS (
  SELECT 1 FROM jobs other
  WHERE other.account_id = j.account_id AND other.brief_id = j.brief_id
    AND other.type = j.type AND other.id <> j.id
)
UNION ALL
SELECT account_id, delivery_job_id, 'live_count_mismatch'
FROM delivery_live_parity WHERE legacy_count <> split_count
UNION ALL
SELECT account_id, NULL::UUID, 'aggregate_live_count_mismatch'
FROM delivery_live_parity_totals WHERE legacy_count <> split_count
UNION ALL
SELECT j.account_id, j.id, 'untracked_legacy_execution'
FROM jobs j
WHERE NOT EXISTS (SELECT 1 FROM delivery_legacy_baseline b WHERE b.id = j.id)
  AND NOT EXISTS (SELECT 1 FROM delivery_legacy_events e WHERE e.legacy_job_id = j.id)
  AND (j.status <> 'queued' OR j.retry_count <> 0 OR j.worker_id IS NOT NULL
       OR j.started_at IS NOT NULL OR j.completed_at IS NOT NULL OR j.error_message IS NOT NULL);

CREATE TABLE delivery_account_rollout (
  account_id UUID PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ,
  rollback_until TIMESTAMPTZ
);
INSERT INTO delivery_account_rollout (account_id) SELECT DISTINCT account_id FROM jobs;

CREATE FUNCTION check_delivery_cutover() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled THEN
    -- Serialize the gate with legacy writes/imports. A flag alone is never
    -- proof of parity; the RPC must continue dual-writing after this check.
    LOCK TABLE jobs, delivery_jobs, delivery_attempts, delivery_history_evidence, delivery_legacy_events
      IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM delivery_cutover_blockers WHERE account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'Delivery cutover blocked for account %; inspect delivery_cutover_blockers', NEW.account_id;
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.enabled_at := NOW();
    ELSIF NOT OLD.enabled THEN
      NEW.enabled_at := NOW();
    ELSE
      NEW.enabled_at := OLD.enabled_at;
    END IF;
    NEW.rollback_until := NEW.enabled_at + INTERVAL '14 days';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_account_cutover_guard
BEFORE INSERT OR UPDATE ON delivery_account_rollout
FOR EACH ROW EXECUTE FUNCTION check_delivery_cutover();

COMMIT;
