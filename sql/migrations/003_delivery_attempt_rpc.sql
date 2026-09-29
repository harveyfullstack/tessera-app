-- RPC boundary for execution writes (DeliveryAttemptRpc).
--
-- ensure_delivery_job looks up or creates the one intent per
-- (account_id, brief_id, type). append_delivery_attempt assigns attempt_number
-- under a per-intent row lock so racing callers receive strictly increasing
-- values instead of colliding on delivery_attempts_job_attempt_key.
--
-- The per-account pilot/rollback flag is evaluated by the application-side
-- RPC, not here; these functions are only called on the new path.

BEGIN;

CREATE OR REPLACE FUNCTION ensure_delivery_job(
  p_account_id UUID,
  p_brief_id UUID,
  p_task_id UUID,
  p_type TEXT,
  p_metadata JSONB
)
RETURNS delivery_jobs AS $$
DECLARE
  v_intent delivery_jobs;
BEGIN
  -- ON CONFLICT waits for a concurrent in-flight insert of the same key, so the
  -- SELECT below always sees exactly one intent.
  INSERT INTO delivery_jobs (account_id, brief_id, task_id, type, metadata)
  VALUES (p_account_id, p_brief_id, p_task_id, p_type, p_metadata)
  ON CONFLICT (account_id, brief_id, type) DO NOTHING;

  SELECT * INTO v_intent
  FROM delivery_jobs
  WHERE account_id = p_account_id
    AND brief_id = p_brief_id
    AND type = p_type;

  RETURN v_intent;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION append_delivery_attempt(
  p_delivery_job_id UUID,
  p_status TEXT,
  p_worker_id TEXT,
  p_response_status INTEGER,
  p_response_latency_ms INTEGER,
  p_error_body TEXT
)
RETURNS delivery_attempts AS $$
DECLARE
  v_next_attempt INTEGER;
  v_attempt delivery_attempts;
BEGIN
  -- Row lock only; SELECT ... FOR NO KEY UPDATE does not fire the
  -- delivery_jobs immutability trigger.
  PERFORM 1 FROM delivery_jobs WHERE id = p_delivery_job_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery job not found: %', p_delivery_job_id;
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_next_attempt
  FROM delivery_attempts
  WHERE delivery_job_id = p_delivery_job_id;

  INSERT INTO delivery_attempts (
    delivery_job_id,
    attempt_number,
    worker_id,
    status,
    response_status,
    response_latency_ms,
    error_body
  )
  VALUES (
    p_delivery_job_id,
    v_next_attempt,
    p_worker_id,
    p_status,
    p_response_status,
    p_response_latency_ms,
    p_error_body
  )
  RETURNING * INTO v_attempt;

  RETURN v_attempt;
END;
$$ LANGUAGE plpgsql;

COMMIT;
