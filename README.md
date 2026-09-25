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

Webhook delivery moves an endpoint to the dead letter queue after eight failed
attempts by default. Set `WEBHOOK_RETRY_BUDGETS` to a JSON object keyed by
account ID to override the limit, for example `{"account-1":12}`. The
`WEBHOOK_DELIVERY_ROLLBACK_ACCOUNTS` is a comma-separated list of account IDs
checked at the delivery-attempt RPC boundary. Because this in-memory demo has no
legacy persistence adapter, delivery operations for listed accounts fail with
`503` rather than silently ignoring the rollback flag. Attempt-number ordering
is atomic only within one process; do not run multiple app processes until a
shared database repository is configured. The `GET /briefs/:briefId/jobs`
endpoint includes DLQ summary and terminal attempt-body details; add
`?status=dlq` to return only dead-lettered endpoints. Configure
`WEBHOOK_ADMIN_TOKEN` and send it as a bearer token in the `Authorization`
header to access this endpoint. It fails closed with `503` when the token is
not configured and returns `401` for missing or invalid credentials.
