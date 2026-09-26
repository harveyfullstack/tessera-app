-- Use for staged/manual backfills; the migration runs equivalent checks
-- transactionally before cutover. Duplicate intents map to one canonical job.
WITH legacy AS (
  SELECT
    delivery_job_id,
    SUM(expected_attempt_count) AS expected_attempt_count
  FROM (
    SELECT
      FIRST_VALUE(j.id) OVER (
        PARTITION BY j.account_id, j.brief_id, j.type
        ORDER BY j.created_at ASC, j.id ASC
      ) AS delivery_job_id,
      CASE
        WHEN j.status = 'queued'
          AND j.worker_id IS NULL
          AND j.started_at IS NULL
          AND j.completed_at IS NULL
          THEN j.retry_count
        ELSE j.retry_count + 1
      END AS expected_attempt_count
    FROM jobs AS j
  ) AS mapped_legacy
  GROUP BY delivery_job_id
),
new_history AS (
  SELECT delivery_job_id, COUNT(*) AS migrated_attempt_count
  FROM delivery_attempts
  GROUP BY delivery_job_id
)
SELECT
  COALESCE(legacy.delivery_job_id, new_history.delivery_job_id) AS delivery_job_id,
  COALESCE(legacy.expected_attempt_count, 0) AS expected_attempt_count,
  COALESCE(new_history.migrated_attempt_count, 0) AS migrated_attempt_count,
  COALESCE(legacy.expected_attempt_count, 0)
    = COALESCE(new_history.migrated_attempt_count, 0) AS parity_matches
FROM legacy
FULL JOIN new_history USING (delivery_job_id)
ORDER BY delivery_job_id;

WITH legacy AS (
  SELECT
    delivery_job_id,
    SUM(expected_attempt_count) AS expected_attempt_count
  FROM (
    SELECT
      FIRST_VALUE(j.id) OVER (
        PARTITION BY j.account_id, j.brief_id, j.type
        ORDER BY j.created_at ASC, j.id ASC
      ) AS delivery_job_id,
      CASE
        WHEN j.status = 'queued'
          AND j.worker_id IS NULL
          AND j.started_at IS NULL
          AND j.completed_at IS NULL
          THEN j.retry_count
        ELSE j.retry_count + 1
      END AS expected_attempt_count
    FROM jobs AS j
  ) AS mapped_legacy
  GROUP BY delivery_job_id
),
totals AS (
  SELECT COALESCE(SUM(expected_attempt_count), 0) AS total_legacy_attempts
  FROM legacy
)
SELECT
  totals.total_legacy_attempts,
  migrated.total_migrated_attempts,
  totals.total_legacy_attempts = migrated.total_migrated_attempts AS aggregate_parity_matches
FROM totals
CROSS JOIN (
  SELECT COUNT(*) AS total_migrated_attempts
  FROM delivery_attempts
) AS migrated;
