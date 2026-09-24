# Tessera Product Intelligence

Tessera is a fictional company. This repository is a demo concept for demonstrating software development workflows with Hamster. It is not a production service. All company, customer, and operational details are fictional.

## Application

The TypeScript source models event ingestion, webhook delivery, query routing, anomaly rollout, cohort queries, and a mobile event SDK. Some paths deliberately represent work before a proposed change, so pull requests can demonstrate a real before-and-after workflow.

- `src/application/`: application services and delivery policies.
- `src/sdk/`: mobile event collection.
- `src/api/`: HTTP interface.
- `src/infrastructure/`: repository implementations.
- `sql/`: database schema and migrations.
- `tests/`: behavior and regression checks.

## Mobile SDK startup contract

The mobile SDK uses a four-entry startup buffer and preserves event order through initialization. A failed flush retains undelivered events without replaying successful deliveries. LTE flush behavior and ProGuard configuration are separate from startup buffering.

## Development

Requires Bun.

```sh
bun install
bun run check
bun run dev
```

## Webhook delivery history

Execution transitions retain immutable history and a compatibility ledger even
when the split is disabled. For the demo, opt accounts into derived delivery
status at startup with `DELIVERY_SPLIT_ACCOUNTS=tessera-demo-account bun run dev`.
The comma-separated account allowlist defaults empty; enabling uses the parity
gate. Remove an account and restart to use its legacy status again. The demo
repository is in-memory and resets on restart; SQL-backed rollout and rollback
procedures are documented in `sql/DELIVERY_MIGRATION.md`.

Enabled accounts display the highest-numbered execution event, or `queued` for
empty history. A running event whose start is more than five minutes old displays
`stuck`; it remains in flight until an explicit retry or terminal transition.

A delivery enters the Dead Letter Queue after **8 failed deliveries** by default
(`failedAttemptCount >= retryBudget`). Running transitions do not consume that
budget. Configure accounts with a JSON object, for example
`DELIVERY_RETRY_BUDGETS='{"tessera-demo-account":3}'`. Failure recording increments
legacy retry count atomically; exhausted deliveries cannot start another send.

`GET /briefs/:briefId/jobs` includes `dlq.pastBudgetCount` (distinct exhausted
endpoints) and `dlq.endpoints`, each containing its job ID, failed delivery count
and up to three error bodies, newest first. `?status=dlq` limits the jobs array to
queued dead letters. The handler scopes all results to its configured account.
The `drain_dlq` processor records its lifecycle through the execution RPC and
idempotently queues exhausted dispatch jobs.

An explicit `JobRecordService.retry(jobId)` records a queued replay transition,
removes current DLQ membership and starts a new failure budget. Success also
resets that budget. Previous execution history remains available, including
through rollback. Automatic failures do not issue that replay transition.
