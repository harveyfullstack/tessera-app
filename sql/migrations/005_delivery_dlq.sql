BEGIN;
CREATE TABLE public.delivery_retry_budgets (
  account_id UUID PRIMARY KEY,
  attempt_budget INTEGER NOT NULL CHECK (attempt_budget > 0)
);
CREATE TABLE public.delivery_dead_letters (
  delivery_job_id UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION public.delivery_failure_count(p_job_id UUID) RETURNS BIGINT
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COUNT(*) FROM public.delivery_legacy_events e
  WHERE e.legacy_job_id = p_job_id AND e.status = 'failed'
    AND e.attempt_number > COALESCE((
      SELECT MAX(attempt_number) FROM public.delivery_legacy_events
      WHERE legacy_job_id = p_job_id AND status IN ('queued', 'completed')
    ), 0);
$$;

CREATE FUNCTION public.drain_delivery_dlq(p_account_id UUID, p_brief_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job public.jobs;
  budget INTEGER;
  total INTEGER := 0;
BEGIN
  SELECT COALESCE((SELECT attempt_budget FROM public.delivery_retry_budgets WHERE account_id = p_account_id), 8) INTO budget;
  FOR job IN SELECT * FROM public.jobs
    WHERE account_id = p_account_id AND brief_id = p_brief_id AND type = 'dispatch_webhook'
    ORDER BY id FOR UPDATE
  LOOP
    IF job.status = 'failed' AND public.delivery_failure_count(job.id) >= budget THEN
      INSERT INTO public.delivery_dead_letters (delivery_job_id) VALUES (job.id) ON CONFLICT DO NOTHING;
      total := total + 1;
    ELSE
      DELETE FROM public.delivery_dead_letters WHERE delivery_job_id = job.id;
    END IF;
  END LOOP;
  RETURN total;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_delivery_attempt(
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
  budget INTEGER;
  event_time TIMESTAMPTZ;
  event_started TIMESTAMPTZ;
  event_completed TIMESTAMPTZ;
  event_worker TEXT;
BEGIN
  SELECT * INTO job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  event_time := clock_timestamp();
  SELECT COALESCE((SELECT attempt_budget FROM public.delivery_retry_budgets WHERE account_id = job.account_id), 8) INTO budget;
  IF job.type = 'dispatch_webhook' AND p_status = 'running' AND public.delivery_failure_count(p_job_id) >= budget THEN
    RAISE EXCEPTION 'Delivery retry budget exhausted for job: %', p_job_id;
  END IF;
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
  IF job.type = 'dispatch_webhook' THEN
    IF p_status = 'failed' AND public.delivery_failure_count(p_job_id) >= budget THEN
      INSERT INTO public.delivery_dead_letters (delivery_job_id) VALUES (p_job_id) ON CONFLICT DO NOTHING;
    ELSIF p_status IN ('queued', 'completed') THEN
      DELETE FROM public.delivery_dead_letters WHERE delivery_job_id = p_job_id;
    END IF;
  END IF;
  RETURN job;
END;
$$;

CREATE VIEW public.delivery_dlq_summary AS
SELECT j.account_id, j.brief_id, q.delivery_job_id, j.metadata ->> 'endpointUrl' AS endpoint_url,
       q.enqueued_at, public.delivery_failure_count(j.id) AS failed_attempt_count,
       (SELECT jsonb_agg(b.error_body ORDER BY b.attempt_number DESC) FROM (
          SELECT error_body, attempt_number FROM public.delivery_legacy_events
          WHERE legacy_job_id = j.id AND status = 'failed'
            AND attempt_number > COALESCE((SELECT MAX(attempt_number) FROM public.delivery_legacy_events
              WHERE legacy_job_id = j.id AND status IN ('queued', 'completed')), 0)
          ORDER BY attempt_number DESC LIMIT 3
        ) b) AS last_attempt_bodies
FROM public.delivery_dead_letters q JOIN public.jobs j ON j.id = q.delivery_job_id;

REVOKE ALL ON FUNCTION public.append_delivery_attempt(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drain_delivery_dlq(UUID, UUID) FROM PUBLIC;
-- CREATE OR REPLACE preserves existing trusted worker EXECUTE grants.
COMMIT;
