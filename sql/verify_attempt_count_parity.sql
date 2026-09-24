-- Attempt-Count Parity Verification Query
-- Proves old/new attempt-count parity for each delivery job and in aggregate.

-- 1. Per-job attempt count parity:
WITH old_attempts_per_job AS (
  SELECT
    dj.id AS delivery_job_id,
    COALESCE(SUM(
      CASE
        WHEN j.status = 'queued' AND j.worker_id IS NULL AND j.started_at IS NULL AND j.retry_count = 0 THEN 0
        WHEN j.status = 'queued' AND j.retry_count > 0 THEN j.retry_count
        ELSE j.retry_count + 1
      END
    ), 0) AS expected_attempt_count
  FROM delivery_jobs dj
  JOIN jobs j ON j.account_id = dj.account_id AND j.brief_id = dj.brief_id AND j.type = dj.type
  GROUP BY dj.id
),
new_attempts_per_job AS (
  SELECT
    dj.id AS delivery_job_id,
    COUNT(da.id) AS actual_attempt_count
  FROM delivery_jobs dj
  LEFT JOIN delivery_attempts da ON da.delivery_job_id = dj.id
  GROUP BY dj.id
)
SELECT
  dj.id AS delivery_job_id,
  dj.account_id,
  dj.brief_id,
  dj.type,
  oa.expected_attempt_count,
  na.actual_attempt_count,
  (oa.expected_attempt_count = na.actual_attempt_count) AS parity_matches
FROM delivery_jobs dj
JOIN old_attempts_per_job oa ON oa.delivery_job_id = dj.id
JOIN new_attempts_per_job na ON na.delivery_job_id = dj.id
ORDER BY dj.created_at ASC;

-- 2. Aggregate attempt count parity:
SELECT
  (SELECT COALESCE(SUM(
    CASE
      WHEN status = 'queued' AND worker_id IS NULL AND started_at IS NULL AND retry_count = 0 THEN 0
      WHEN status = 'queued' AND retry_count > 0 THEN retry_count
      ELSE retry_count + 1
    END
  ), 0) FROM jobs) AS total_old_attempts,
  (SELECT COUNT(*) FROM delivery_attempts) AS total_new_attempts,
  ((SELECT COALESCE(SUM(
    CASE
      WHEN status = 'queued' AND worker_id IS NULL AND started_at IS NULL AND retry_count = 0 THEN 0
      WHEN status = 'queued' AND retry_count > 0 THEN retry_count
      ELSE retry_count + 1
    END
  ), 0) FROM jobs) = (SELECT COUNT(*) FROM delivery_attempts)) AS aggregate_parity_matches;
