BEGIN;

-- The existing (delivery_job_id, attempt_number DESC) index serves this lookup.
CREATE FUNCTION public.delivery_display_status(p_job_id UUID, p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS TEXT LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN NOT COALESCE(r.enabled, FALSE) THEN j.status
    WHEN a.attempt_number IS NULL THEN 'queued'
    WHEN a.status = 'running' AND a.started_at < p_now - INTERVAL '5 minutes' THEN 'stuck'
    ELSE a.status
  END
  FROM public.jobs j
  LEFT JOIN public.delivery_account_rollout r ON r.account_id = j.account_id
  LEFT JOIN LATERAL (
    SELECT attempt_number, status, started_at FROM public.delivery_attempts
    WHERE delivery_job_id = j.id ORDER BY attempt_number DESC LIMIT 1
  ) a ON TRUE
  WHERE j.id = p_job_id;
$$;

COMMIT;
