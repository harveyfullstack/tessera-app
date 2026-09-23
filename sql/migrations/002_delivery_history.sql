-- Additive migration: legacy jobs remain the rollback path. Unknown historical
-- attempts are preserved as snapshots, never synthesized from retry_count.
BEGIN;
LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;
-- SECURITY DEFINER functions resolve objects only in trusted schemas.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE delivery_rollouts (
  account_id UUID PRIMARY KEY,
  capture_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMPTZ,
  rollback_until TIMESTAMPTZ,
  CHECK (NOT enabled OR (enabled_at IS NOT NULL AND rollback_until >= enabled_at + INTERVAL '14 days'))
);

CREATE TABLE legacy_job_snapshots (
  legacy_job_id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provenance TEXT NOT NULL DEFAULT 'legacy_snapshot_history_unknown'
    CHECK (provenance = 'legacy_snapshot_history_unknown')
);

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, brief_id, type)
);

-- A separate forward ledger makes legacy/new counts independently observable.
CREATE TABLE legacy_execution_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX legacy_execution_events_job_idx ON legacy_execution_events (legacy_job_id);

CREATE TABLE delivery_attempts (
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
  legacy_event_id BIGINT NOT NULL UNIQUE REFERENCES legacy_execution_events(id) ON DELETE RESTRICT,
  worker_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('execution', 'retry')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'dlq')),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_job_id, attempt_number)
);
CREATE INDEX delivery_attempts_latest_idx ON delivery_attempts (delivery_job_id, attempt_number DESC);

CREATE FUNCTION reject_delivery_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; % is prohibited', TG_TABLE_NAME, TG_OP;
END;
$$;
CREATE TRIGGER delivery_jobs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_jobs
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER delivery_attempts_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON delivery_attempts
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER legacy_snapshots_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON legacy_job_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER legacy_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON legacy_execution_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

INSERT INTO delivery_rollouts (account_id) SELECT DISTINCT account_id FROM jobs;
INSERT INTO legacy_job_snapshots (legacy_job_id, account_id, snapshot)
SELECT id, account_id, to_jsonb(jobs) FROM jobs;
-- Do not choose a winner for duplicate intents. Preserve all originals and
-- block account cutover until an operator supplies an explicit resolution.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
SELECT id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at
FROM jobs j WHERE NOT EXISTS (
  SELECT 1 FROM jobs other WHERE other.account_id = j.account_id
    AND other.brief_id = j.brief_id AND other.type = j.type AND other.id <> j.id
);

-- Existing imported intent cannot drift, and enabled accounts cannot acquire
-- duplicate legacy keys through a writer that bypasses preparation.
CREATE FUNCTION guard_legacy_delivery_intent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM delivery_rollouts WHERE account_id = NEW.account_id FOR UPDATE;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM delivery_jobs WHERE id = OLD.id) AND
    ROW(NEW.id, NEW.account_id, NEW.brief_id, NEW.task_id, NEW.parent_job_id, NEW.type, NEW.metadata, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.brief_id, OLD.task_id, OLD.parent_job_id, OLD.type, OLD.metadata, OLD.created_at) THEN
    RAISE EXCEPTION 'Imported delivery intent is immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM delivery_rollouts WHERE account_id = NEW.account_id AND enabled)
    AND EXISTS (SELECT 1 FROM jobs WHERE account_id = NEW.account_id
      AND brief_id = NEW.brief_id AND type = NEW.type AND id <> NEW.id) THEN
    RAISE EXCEPTION 'Enabled account cannot create duplicate delivery intent';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_legacy_delivery_intent BEFORE INSERT OR UPDATE OF id, account_id,
  brief_id, task_id, parent_job_id, type, metadata, created_at ON jobs
FOR EACH ROW EXECUTE FUNCTION guard_legacy_delivery_intent();
CREATE TRIGGER preserve_legacy_rollback BEFORE DELETE OR TRUNCATE ON jobs
FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

CREATE FUNCTION capture_legacy_execution_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO legacy_execution_events (legacy_job_id, account_id, snapshot)
  VALUES (NEW.id, NEW.account_id, to_jsonb(NEW));
  RETURN NEW;
END;
$$;
-- Direct legacy writes are visible as parity gaps, including repeated writes
-- of identical state. A queued/retry transition is an execution event too.
CREATE TRIGGER capture_legacy_execution AFTER UPDATE OF status, worker_id, retry_count,
  error_message, started_at, completed_at ON jobs
FOR EACH ROW EXECUTE FUNCTION capture_legacy_execution_event();

CREATE VIEW delivery_attempt_parity AS
SELECT j.id AS delivery_job_id, j.account_id,
  (SELECT count(*) FROM legacy_execution_events e WHERE e.legacy_job_id = j.id) AS legacy_count,
  (SELECT count(*) FROM delivery_attempts a WHERE a.delivery_job_id = j.id) AS attempt_count,
  EXISTS (SELECT 1 FROM delivery_jobs d WHERE d.id = j.id) AS intent_imported,
  NOT EXISTS (
    SELECT 1 FROM delivery_jobs d WHERE d.id = j.id AND
      ROW(d.account_id, d.brief_id, d.task_id, d.parent_job_id, d.type, d.metadata, d.created_at)
      IS DISTINCT FROM ROW(j.account_id, j.brief_id, j.task_id, j.parent_job_id, j.type, j.metadata, j.created_at)
  ) AS intent_matches
FROM jobs j;

CREATE VIEW delivery_account_parity AS
SELECT account_id, sum(legacy_count) AS legacy_count, sum(attempt_count) AS attempt_count,
  bool_and(legacy_count = attempt_count AND intent_imported AND intent_matches) AS ready
FROM delivery_attempt_parity GROUP BY account_id;

-- Enrollment/import can be rerun after explicit duplicate resolution. It never
-- edits legacy rows, snapshots, or already imported intent.
CREATE FUNCTION prepare_delivery_account(p_account_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO delivery_rollouts (account_id) VALUES (p_account_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM delivery_rollouts WHERE account_id = p_account_id FOR UPDATE;
  INSERT INTO legacy_job_snapshots (legacy_job_id, account_id, snapshot)
  SELECT id, account_id, to_jsonb(j) FROM jobs j WHERE account_id = p_account_id
  ON CONFLICT DO NOTHING;
  INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
  SELECT id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at FROM jobs j
  WHERE account_id = p_account_id AND NOT EXISTS (
    SELECT 1 FROM jobs other WHERE other.account_id = j.account_id
      AND other.brief_id = j.brief_id AND other.type = j.type AND other.id <> j.id
  ) ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION set_delivery_split(p_account_id UUID, p_enabled BOOLEAN) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Freeze legacy writers for the check, including writers bypassing the RPC.
  LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;
  PERFORM prepare_delivery_account(p_account_id);
  IF p_enabled AND (
    EXISTS (SELECT 1 FROM jobs WHERE account_id = p_account_id
      GROUP BY brief_id, type HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM delivery_account_parity WHERE account_id = p_account_id AND NOT ready)
  ) THEN
    RAISE EXCEPTION 'Account % has unresolved duplicate intents or forward parity gaps', p_account_id;
  END IF;
  UPDATE delivery_rollouts SET enabled = p_enabled,
    enabled_at = CASE WHEN p_enabled THEN coalesce(enabled_at, now()) ELSE enabled_at END,
    rollback_until = CASE WHEN p_enabled THEN greatest(coalesce(rollback_until, now()), now() + INTERVAL '14 days') ELSE rollback_until END
  WHERE account_id = p_account_id;
END;
$$;

-- Each call appends one execution-state event, not one HTTP transmission.
-- The account flag selects reads; both stores keep receiving writes even after
-- rollback, so toggling the flag never discards the execution timeline.
CREATE FUNCTION append_delivery_attempt(
  p_job_id UUID, p_status TEXT, p_worker_id TEXT DEFAULT NULL,
  p_response_status INTEGER DEFAULT NULL, p_response_latency_ms INTEGER DEFAULT NULL,
  p_error_body TEXT DEFAULT NULL, p_retry BOOLEAN DEFAULT false
) RETURNS delivery_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  legacy jobs;
  next_number BIGINT;
  event_id BIGINT;
  appended delivery_attempts;
BEGIN
  -- Match the cutover lock order to avoid deadlocks with flag changes.
  LOCK TABLE jobs IN ROW EXCLUSIVE MODE;
  SELECT * INTO STRICT legacy FROM jobs WHERE id = p_job_id;
  PERFORM prepare_delivery_account(legacy.account_id);
  SELECT * INTO STRICT legacy FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF p_status = 'running' AND legacy.status = 'dlq' THEN
    RAISE EXCEPTION 'Job % is in the dead letter queue', p_job_id;
  END IF;
  IF p_status = 'running' AND legacy.status = 'running' THEN
    RAISE EXCEPTION 'Job % is already running', p_job_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM delivery_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'Job % has an unresolved duplicate intent', p_job_id;
  END IF;
  IF EXISTS (SELECT 1 FROM delivery_attempt_parity WHERE delivery_job_id = p_job_id AND NOT intent_matches) THEN
    RAISE EXCEPTION 'Job % legacy intent differs from immutable intent', p_job_id;
  END IF;
  SELECT coalesce(max(attempt_number), 0) + 1 INTO next_number
  FROM delivery_attempts WHERE delivery_job_id = p_job_id;
  UPDATE jobs SET status = p_status, worker_id = coalesce(p_worker_id, worker_id),
    retry_count = retry_count + CASE WHEN p_retry THEN 1 ELSE 0 END,
    error_message = p_error_body, updated_at = now(),
    started_at = CASE WHEN p_status = 'running' THEN now() ELSE started_at END,
    completed_at = CASE WHEN p_status IN ('completed', 'failed', 'cancelled', 'dlq') THEN now() ELSE completed_at END
  WHERE id = p_job_id;
  SELECT max(id) INTO event_id FROM legacy_execution_events WHERE legacy_job_id = p_job_id;
  INSERT INTO delivery_attempts (delivery_job_id, attempt_number, legacy_event_id,
    worker_id, operation, status, response_status, response_latency_ms, error_body, started_at, completed_at)
  VALUES (p_job_id, next_number, event_id, coalesce(p_worker_id, legacy.worker_id),
    CASE WHEN p_retry THEN 'retry' ELSE 'execution' END,
    p_status, p_response_status, p_response_latency_ms, p_error_body,
    CASE WHEN p_status = 'running' THEN now() ELSE legacy.started_at END,
    CASE WHEN p_status IN ('completed', 'failed', 'cancelled', 'dlq') THEN now() ELSE NULL END)
  RETURNING * INTO appended;
  RETURN appended;
END;
$$;

-- Deployments must grant their execution role only the RPC functions and read
-- access. Do not grant direct table writes or ownership to an application role.
REVOKE ALL ON delivery_jobs, delivery_attempts, legacy_job_snapshots,
  legacy_execution_events, delivery_rollouts FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prepare_delivery_account(UUID), set_delivery_split(UUID, BOOLEAN),
  append_delivery_attempt(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN) FROM PUBLIC;
COMMIT;
