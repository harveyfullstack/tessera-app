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
