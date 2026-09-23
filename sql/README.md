# Delivery history migration

Apply `migrations/001_init_jobs.sql` and then `migrations/002_delivery_history.sql` in order. The second migration is additive and transactional; it retains every `jobs` row and captures its full contents in `legacy_job_snapshots`. Snapshots explicitly have unknown historical attempt history. `retry_count` is not an execution count and is never expanded into synthetic attempts.

Unique legacy intents import into immutable `delivery_jobs`. Duplicate keys remain untouched in `jobs` and snapshots; their accounts cannot enable the split. Resolving duplicates requires a separately reviewed mapping/archive decision. The migration deliberately does not merge or discard them. Intent mismatches also block cutover.

`append_delivery_attempt(job_id, status, worker_id, response_status, response_latency_ms, error_body, retry)` locks the account and job, allocates a sequence number, updates the legacy row and appends history in one transaction. Each call represents an execution-state event, including running, terminal state and retry scheduling (identified by `operation`); `attempt_number` is not an HTTP transmission counter. Responses may be unknown. Failures roll back both paths. Use this boundary for every execution write, whether an account flag is enabled or disabled.

A trigger records forward legacy execution writes separately in `legacy_execution_events`, including writes bypassing the RPC. `delivery_attempt_parity` compares counts per job; `delivery_account_parity` aggregates them. A bypassing legacy write leaves a detectable gap and blocks the next cutover. Historical snapshots are excluded from both counts. Parity certifies only the post-migration capture window, not lost historical executions. Legacy snapshots remain separately available; the enabled attempt-derived display is queued until forward history exists, without inventing an attempt.

Call `prepare_delivery_account(account_id)` after creating new legacy intent, or let the append boundary prepare it. Inspect both parity views before calling `set_delivery_split(account_id, true)`. That function freezes legacy writers during preflight and refuses unresolved duplicates, missing intent, intent mismatches or count gaps. It records a minimum 14-day rollback window. Roll back with `set_delivery_split(account_id, false)`; both stores continue receiving events, so rollback and re-enablement preserve history. No cleanup or legacy deletion is included; retention exceeds the 14-day minimum. The flag selects the application read path; this repository's runnable application uses the in-memory equivalent rather than a PostgreSQL adapter.

The functions use a fixed search path with caller-controlled temporary schemas last. The migration revokes public-schema creation from `PUBLIC`; deployment must also ensure no application role has an explicit `CREATE` grant on that schema. The migration owner must be a trusted non-application role. Grant application roles read access and `EXECUTE` on `append_delivery_attempt` only; grant `prepare_delivery_account` / `set_delivery_split` to the migration/rollout operator. Do not grant applications direct table writes, sequence privileges, ownership or trigger-bypass privileges. Intent creation remains an operator-owned path for this SQL reference schema. Production role provisioning and deployment are outside this demo.

Run the integration fixture in an **empty disposable database**, from this directory's parent:

```sh
psql -v ON_ERROR_STOP=1 -f sql/tests/delivery_history.sql
```

It applies both migrations and checks preservation, duplicate blocking, unknown-history provenance, forward parity, legacy mirroring, rollback, append-only enforcement and bypass detection. The fixture leaves its initial seed/migrations in the disposable database; behavior checks run in a rolled-back transaction. No production cohort or observation-window evidence is implied by this fixture.
