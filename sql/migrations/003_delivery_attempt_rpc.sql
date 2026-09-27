-- All new execution writes use this boundary. The row lock makes
-- attempt_number allocation monotonic when workers race on one delivery job.
-- The account rollback gate is evaluated in the same transaction.

CREATE TABLE IF NOT EXISTS delivery_account_rollbacks (
  account_id UUID PRIMARY KEY,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_error_body_length
  CHECK (error_body IS NULL OR length(error_body) <= 16384);

CREATE OR REPLACE FUNCTION record_delivery_attempt(
  p_delivery_job_id UUID,
  p_status TEXT,
  p_worker_id TEXT DEFAULT NULL,
  p_response_status INTEGER DEFAULT NULL,
  p_response_latency_ms INTEGER DEFAULT NULL,
  p_error_body TEXT DEFAULT NULL
) RETURNS delivery_attempts
LANGUAGE plpgsql
AS $$
DECLARE
  v_job delivery_jobs%ROWTYPE;
  v_attempt delivery_attempts%ROWTYPE;
  v_attempt_number INTEGER;
BEGIN
  IF length(p_error_body) > 16384 THEN
    RAISE EXCEPTION 'delivery attempt error body exceeds 16384 characters';
  END IF;

  SELECT * INTO v_job
  FROM delivery_jobs
  WHERE id = p_delivery_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery job % not found', p_delivery_job_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM delivery_account_rollbacks
    WHERE account_id = v_job.account_id
  ) THEN
    RAISE EXCEPTION 'delivery job % is gated to the legacy rollback path', p_delivery_job_id;
  END IF;

  IF p_status = 'running' THEN
    SELECT COALESCE(MAX(attempt_number), 0) + 1
    INTO v_attempt_number
    FROM delivery_attempts
    WHERE delivery_job_id = p_delivery_job_id;

    INSERT INTO delivery_attempts (
      delivery_job_id, attempt_number, worker_id, status,
      response_status, response_latency_ms, error_body
    )
    VALUES (
      p_delivery_job_id, v_attempt_number, p_worker_id, 'running',
      p_response_status, p_response_latency_ms, p_error_body
    )
    RETURNING * INTO v_attempt;
  ELSE
    UPDATE delivery_attempts
    SET status = p_status,
        worker_id = COALESCE(p_worker_id, worker_id),
        response_status = p_response_status,
        response_latency_ms = p_response_latency_ms,
        error_body = p_error_body,
        completed_at = NOW()
    WHERE id = (
      SELECT id
      FROM delivery_attempts
      WHERE delivery_job_id = p_delivery_job_id AND status = 'running'
      ORDER BY attempt_number DESC
      LIMIT 1
      FOR UPDATE
    )
    RETURNING * INTO v_attempt;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'no running delivery attempt for job %', p_delivery_job_id;
    END IF;
  END IF;

  RETURN v_attempt;
END;
$$;
