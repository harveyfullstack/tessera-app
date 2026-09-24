-- Post-split schema. 001 retains the Phase 1 jobs retry queue so rollback stays possible.
\i migrations/001_init_jobs.sql
\i migrations/002_split_delivery_jobs_and_attempts.sql
\i migrations/003_delivery_attempt_started_at.sql
