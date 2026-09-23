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

## Webhook delivery hardening

Delivery intent and execution history are stored separately. Each execution state
change appends a numbered history entry; a history entry is not necessarily a
new HTTP delivery. Retry budgets count failed executions rather than lifecycle
entries. Intent is unique within an account, brief, and job type.

The migration is additive: legacy `jobs` rows remain available for rollback.
Their original state is preserved as a legacy snapshot, not represented as
reconstructed attempt history. Earlier attempts were overwritten by the old
model and cannot be recovered from its retry counter. Accounts with unresolved
duplicate intent keys cannot cut over.

New executions capture both legacy state and append-only history. Per-job and
aggregate parity checks cover this capture period only. Account rollout defaults
to the legacy read path; enabling the new path requires passing its cutover
checks. Rollback switches reads back to the preserved legacy path while capture
continues. Keep both stores throughout the 14-day rollback window.

The runnable application uses an in-memory repository. PostgreSQL migrations and
integration fixtures exercise the database contract separately; applying them
does not connect the demo application to PostgreSQL or enable pilot accounts.
