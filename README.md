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

## Webhook dead letters

The `drain_dlq` processor runs before dispatch and after failures for accounts on
the attempt-history path. Pilot and rollback account sets still ship empty;
rollback wins. Supply per-account retry budgets using `JobRecordService`'s
`retryBudgets` map; the default is eight failed deliveries. Running, retry, and
DLQ bookkeeping rows do not consume this budget. The first append atomically snapshots the largest retry count across legacy
rows mapped to the intent. That immutable `legacyRetryCount` baseline plus new
failed outcome rows preserves pre-cutover exhaustion across duplicates. Current
legacy retry counts remain a lower bound, without double-counting retry and
failed lifecycle records.
At the budget boundary the job enters `dlq`, and further pilot execution writes
cannot restart it. Legacy rollback continues using `jobs` without appending rows.

`GET /briefs/:briefId/jobs?status=dlq` filters by derived status. Each pilot
webhook job's `dlq` field reports the canonical delivery ID and metadata endpoint,
the budget, failure count, and `pastBudgetCount` (failures exceeding the budget,
zero at exactly eight with the default). `attempts` contains the latest three
append-only records with stored bodies, descending by attempt number; bodyless
bookkeeping rows do not displace failure bodies. Identity remains `(deliveryJobId, attemptNumber)`.
Pre-cutover bodies are never fabricated. Apply migration `003_delivery_dlq.sql`
after `002_delivery_intents_and_attempts.sql` to allow the new terminal status.
