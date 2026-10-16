# Tessera Product Intelligence

Tessera Product Intelligence contains modules for event ingestion, webhook delivery tracking, query routing, anomaly rollout, cohort queries, and a mobile event SDK.

## Application

The TypeScript application contains the following modules:

- `src/application/`: application services and delivery policies.
- `src/sdk/`: mobile event collection.
- `src/api/`: HTTP interface.
- `src/infrastructure/`: repository implementations.
- `sql/`: database schema and migrations.
- `tests/`: behavior and regression checks.
- `web/`: the webhook Deliveries dashboard, a static page that Vercel serves (`vercel.json`).

## Mobile SDK startup contract

The mobile SDK uses a four-entry startup buffer and preserves event order through initialization. A failed flush retains undelivered events without replaying successful deliveries. LTE flush behavior and ProGuard configuration are separate from startup buffering.

## Development

Requires Bun.

```sh
bun install
bun run check
bun run dev
```
