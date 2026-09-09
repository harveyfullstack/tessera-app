BEGIN;

\i migrations/001_init_jobs.sql
\i migrations/002_delivery_jobs_and_attempts.sql

COMMIT;
