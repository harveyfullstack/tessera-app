BEGIN;

ALTER TABLE delivery_legacy_events
  ADD COLUMN worker_id TEXT,
  ADD COLUMN response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  ADD COLUMN response_latency_ms INTEGER CHECK (response_latency_ms >= 0),
  ADD COLUMN error_body TEXT,
  ADD COLUMN error_message TEXT,
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE delivery_attempts ADD COLUMN error_message TEXT;

CREATE FUNCTION public.append_delivery_attempt(
  p_job_id UUID,
  p_status TEXT,
  p_worker_id TEXT DEFAULT NULL,
  p_response_status INTEGER DEFAULT NULL,
  p_response_latency_ms INTEGER DEFAULT NULL,
  p_error_body TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_increment_retry BOOLEAN DEFAULT FALSE
) RETURNS public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.jobs;
  split_enabled BOOLEAN;
  next_number INTEGER;
  event_time TIMESTAMPTZ;
  event_started TIMESTAMPTZ;
  event_completed TIMESTAMPTZ;
  event_worker TEXT;
BEGIN
  SELECT * INTO job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  event_time := clock_timestamp();
  SELECT enabled INTO split_enabled FROM public.delivery_account_rollout WHERE account_id = job.account_id;
  IF p_status = 'running' AND job.status = 'running' THEN
    RAISE EXCEPTION 'Delivery is already running for job: %', p_job_id;
  END IF;
  IF COALESCE(split_enabled, FALSE) AND NOT EXISTS (SELECT 1 FROM public.delivery_jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'Enabled account is missing immutable delivery intent: %', p_job_id;
  END IF;
  SELECT GREATEST(
    COALESCE((SELECT MAX(attempt_number) FROM public.delivery_attempts WHERE delivery_job_id = p_job_id), 0),
    COALESCE((SELECT MAX(attempt_number) FROM public.delivery_legacy_events WHERE legacy_job_id = p_job_id), 0)
  ) + 1 INTO next_number;
  event_worker := COALESCE(p_worker_id, job.worker_id);
  event_started := CASE WHEN p_status = 'running' THEN event_time ELSE job.started_at END;
  event_completed := CASE WHEN p_status IN ('completed', 'failed', 'cancelled') THEN event_time ELSE NULL END;
  -- Always retain complete prospective history, including conflicted legacy
  -- intents which cannot yet have a row in delivery_jobs.
  INSERT INTO public.delivery_legacy_events
    (legacy_job_id, attempt_number, status, worker_id, response_status, response_latency_ms,
     error_body, error_message, started_at, completed_at, created_at)
  VALUES (p_job_id, next_number, p_status, event_worker, p_response_status, p_response_latency_ms,
          COALESCE(p_error_body, p_error_message), p_error_message, event_started, event_completed, event_time);
  IF EXISTS (SELECT 1 FROM public.delivery_jobs WHERE id = p_job_id) THEN
    INSERT INTO public.delivery_attempts
      (id, delivery_job_id, attempt_number, status, worker_id, response_status, response_latency_ms,
       error_body, error_message, started_at, completed_at, created_at)
    VALUES (gen_random_uuid(), p_job_id, next_number, p_status, event_worker, p_response_status, p_response_latency_ms,
            COALESCE(p_error_body, p_error_message), p_error_message, event_started, event_completed, event_time);
  END IF;
  UPDATE public.jobs SET status = p_status, worker_id = event_worker,
    retry_count = retry_count + CASE WHEN p_increment_retry THEN 1 ELSE 0 END,
    error_message = p_error_message, started_at = event_started, completed_at = event_completed,
    updated_at = event_time
  WHERE id = p_job_id RETURNING * INTO job;
  RETURN job;
END;
$$;

REVOKE ALL ON FUNCTION public.append_delivery_attempt(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
-- Deployment grants EXECUTE to its trusted worker role only; no application
-- role receives direct INSERT/UPDATE/DELETE grants on either event table.
COMMIT;
