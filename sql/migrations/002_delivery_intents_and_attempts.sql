BEGIN;

-- Keep jobs and its duplicate keys intact throughout the 14-day rollback bar.
-- Lock out writers while backfilling so no legacy row can miss its mapping.
LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE;

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  brief_id UUID NOT NULL,
  task_id UUID,
  parent_job_id UUID,
  type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, brief_id, type)
);

-- The oldest row wins deterministically; every original row remains in jobs.
INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
SELECT DISTINCT ON (account_id, brief_id, type)
  id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at
FROM jobs
ORDER BY account_id, brief_id, type, created_at, id;

ALTER TABLE jobs ADD COLUMN delivery_job_id UUID REFERENCES delivery_jobs(id) ON DELETE RESTRICT;
UPDATE jobs AS legacy SET delivery_job_id = intent.id
FROM delivery_jobs AS intent
WHERE legacy.account_id = intent.account_id
  AND legacy.brief_id = intent.brief_id AND legacy.type = intent.type;
ALTER TABLE jobs ALTER COLUMN delivery_job_id SET NOT NULL;
CREATE INDEX jobs_delivery_job_idx ON jobs (delivery_job_id);

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  error_body TEXT,
  UNIQUE (delivery_job_id, attempt_number)
);
CREATE INDEX delivery_attempts_latest_idx ON delivery_attempts (delivery_job_id, attempt_number DESC);

-- No attempt backfill: retry_count is the only surviving legacy signal.
CREATE FUNCTION reject_delivery_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER delivery_jobs_immutable
  BEFORE UPDATE OR DELETE ON delivery_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER delivery_jobs_no_truncate
  BEFORE TRUNCATE ON delivery_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_delivery_history_mutation();
CREATE TRIGGER delivery_attempts_no_truncate
  BEFORE TRUNCATE ON delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_delivery_history_mutation();

-- Legacy writers continue to insert duplicates without an application cutover.
-- ON CONFLICT never updates an existing immutable intent. Under READ COMMITTED,
-- the following SELECT sees the winner after a concurrent insert commits.
CREATE FUNCTION map_legacy_delivery_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO delivery_jobs (id, account_id, brief_id, task_id, parent_job_id, type, metadata, created_at)
  VALUES (NEW.id, NEW.account_id, NEW.brief_id, NEW.task_id, NEW.parent_job_id, NEW.type, NEW.metadata, NEW.created_at)
  ON CONFLICT (account_id, brief_id, type) DO NOTHING;

  SELECT id INTO STRICT NEW.delivery_job_id FROM delivery_jobs
  WHERE account_id = NEW.account_id AND brief_id = NEW.brief_id AND type = NEW.type;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_map_delivery_intent BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION map_legacy_delivery_intent();

CREATE FUNCTION preserve_legacy_delivery_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.delivery_job_id, NEW.account_id, NEW.brief_id, NEW.type)
    IS DISTINCT FROM (OLD.delivery_job_id, OLD.account_id, OLD.brief_id, OLD.type) THEN
    RAISE EXCEPTION 'Legacy delivery intent mapping is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_preserve_delivery_mapping BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION preserve_legacy_delivery_mapping();

COMMIT;
