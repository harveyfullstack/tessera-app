# Delivery history migration

Apply `migrations/002_delivery_history.sql` after `001_init_jobs.sql`. It is a
transactional, one-time additive migration. Phase 1 `jobs` remains available for
rollback; `delivery_legacy_baseline` preserves every original row, including
duplicates. Accounts with duplicate intents or cross-account parent references
remain in Phase 1; all other intent rows retain their IDs and metadata in
`delivery_jobs`. No historical attempt rows are fabricated from `retry_count`.

This implements the approved plan change: preserve legacy rows, capture complete
history going forward, and block cutover for unresolved history or duplicate
intents. The previous schema cannot establish historical attempt counts.

## Contract for the execution RPC

- An attempt row records an execution transition (`running`, terminal status, or
  retry/`queued`). `attempt_number` orders these events, not physical HTTP sends.
- Serialize on the delivery job when allocating the next positive event number.
  Insert `delivery_attempts` with `origin = 'live'`, update the compatibility
  `jobs` state, and insert the same number/status into `delivery_legacy_events`
  in one transaction. Keep this capture active when the account flag is off.
- Populate `started_at` when entering `running`, and `completed_at` for terminal
  states. `created_at` is the event recording timestamp. Carry worker identity
  and response details explicitly; intent rows cannot be updated.
- Create both the immutable intent and the rollback `jobs` row transactionally.
  Scope uniqueness by `(account_id, brief_id, type)`.
- Enforce the RPC write boundary through database privileges in the deployment
  role. This repository has no application database roles to grant or revoke.
  Import/evidence writes belong to the migration operator, never an end user.

## Cutover and rollback

Inspect `delivery_cutover_blockers` before enabling any account. Historical
counts are unknown until an operator supplies an authoritative export, imports
its actual events using `origin = 'legacy_import'`, and records the count and
source in `delivery_history_evidence`. Even queued baseline rows require
evidence; zero cannot be inferred from their current status. Import historical
events before starting live numbering, or resolve their ordering explicitly.
Duplicate intent reconciliation is deliberately not automated.

`delivery_history_parity` and `delivery_history_parity_totals` compare imported
history with evidence. `delivery_live_parity` and `delivery_live_parity_totals`
independently count the compatibility ledger and live attempt rows. Per-job and
aggregate mismatches prevent enabling. The account flag defaults off; the gate
checks on every enable write, including writes that leave it enabled.

```sql
UPDATE delivery_account_rollout SET enabled = TRUE WHERE account_id = '<uuid>';
-- Immediate rollback, even if a parity check is failing:
UPDATE delivery_account_rollout SET enabled = FALSE WHERE account_id = '<uuid>';
```

First enable and each re-enable start a 14-day `rollback_until` window. Keep
legacy dual writes and all tables throughout that window. This migration does
not delete them after the window. Run the SQL verification fixture in a
disposable database with `psql -v ON_ERROR_STOP=1 -f sql/verification/delivery_history.sql`.
The schema gate is preparation for cutover, not evidence that a production
cohort or rollback rehearsal has passed.

## Activate complete capture

Quiesce legacy writers before taking the `002` baseline and keep them paused
until `003_delivery_attempt_rpc.sql` and the application RPC are installed.
A legacy writer running in that gap could overwrite execution state with no
recorded event. Resume workers only through `append_delivery_attempt`; then
resolve historical evidence and evaluate the account gate. For an existing
installation that already had such a gap, leave cutover blocked until its
missing history is resolved from an authoritative source.

The SQL RPC locks the legacy job row to allocate event numbers across workers.
Its security-definer search path is fixed to `pg_catalog`, its table references
are schema-qualified, and PUBLIC cannot execute it. The deployment owner must
grant EXECUTE only to its trusted worker role and remove direct write privileges
on jobs/events from that role. There is no tenant-facing database role in this
repository; the trusted caller must authorize job IDs before invoking the RPC.

For duplicate intents that cannot migrate, the expanded `delivery_legacy_events`
ledger retains worker, status, response, error and timing fields in full. Such
accounts continue to fail cutover checks; capture does not falsely resolve their
old history. The in-memory demo adapter likewise treats all seeded legacy rows
as unresolved and captures their prospective events in the compatibility ledger.

A second `running` transition while already running is rejected atomically,
preventing racing workers from starting the same delivery. Accepted execution
transitions each receive a new event; supplied attempt numbers are ignored.

Run `sql/verification/delivery_rpc.sql` in an empty disposable database to check
both migrations and capture during rollback. Keep compatibility writes active
for the entire 14-day rollback window; flipping the flag never stops capture.
