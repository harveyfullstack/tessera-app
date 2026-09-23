-- Old/new attempt-count parity check (TESSERA-1880). Run it before opening an
-- account's delivery-attempts flag and at every widening boundary.
-- Views are defined in migrations/002_split_delivery_jobs_and_attempts.sql.

-- Parity for all accounts and for each account. Every row must have in_parity = true.
SELECT scope, account_id, jobs_checked, jobs_out_of_parity,
       legacy_attempt_total, attempt_total, in_parity
FROM delivery_attempt_parity_summary
ORDER BY scope DESC, account_id;

-- Jobs out of parity. Any row returned blocks cutover.
SELECT delivery_job_id, account_id, legacy_attempt_count, attempt_count,
       latest_attempt_number
FROM delivery_attempt_parity
WHERE NOT in_parity
ORDER BY account_id, delivery_job_id;
