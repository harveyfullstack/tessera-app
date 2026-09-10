import { describe, expect, test } from "bun:test";
import {
  backfillAttemptsFromLegacyJob,
  migrateDeliveryJobs,
  verifyMigratedAttemptCountParity,
  verifyTerminalAttemptCountParity,
} from "../src/application/delivery-job-migration";
import { DuplicateAttemptNumberError } from "../src/domain/delivery-attempt-repository";
import type { JobRecord } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function job(overrides: Partial<JobRecord>): JobRecord {
  const now = new Date("2026-09-10T00:00:00.000Z");
  return {
    id: overrides.id ?? crypto.randomUUID(),
    accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    briefId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    type: "dispatch_webhook",
    metadata,
    status: "queued",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("delivery job migration", () => {
  test("archives duplicate intents and keeps a single canonical row", () => {
    const older = job({
      id: "11111111-1111-1111-1111-111111111111",
      status: "failed",
      retryCount: 2,
      errorMessage: "older duplicate",
      updatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    const canonical = job({
      id: "22222222-2222-2222-2222-222222222222",
      status: "failed",
      retryCount: 3,
      errorMessage: "canonical duplicate",
      updatedAt: new Date("2026-09-10T01:00:00.000Z"),
    });
    const other = job({
      id: "33333333-3333-3333-3333-333333333333",
      briefId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      status: "completed",
      retryCount: 1,
    });

    const migrated = migrateDeliveryJobs([older, canonical, other]);

    expect(migrated.deliveryJobs.map((row) => row.id).sort()).toEqual([
      canonical.id,
      other.id,
    ]);
    expect(migrated.archivedDuplicates).toHaveLength(1);
    expect(migrated.archivedDuplicates[0]?.id).toBe(older.id);
    expect(migrated.archivedDuplicates[0]?.canonicalDeliveryJobId).toBe(canonical.id);
  });

  test("backfills lifecycle history without dropping prior failures", () => {
    const running = job({ status: "running", retryCount: 2 });
    const cancelled = job({
      id: "55555555-5555-5555-5555-555555555555",
      briefId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      status: "cancelled",
      retryCount: 1,
      errorMessage: "operator cancelled",
    });
    const requeued = job({
      id: "66666666-6666-6666-6666-666666666666",
      briefId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      status: "queued",
      retryCount: 2,
      errorMessage: "last retry failure",
    });
    const fresh = job({
      id: "77777777-7777-7777-7777-777777777777",
      briefId: "99999999-9999-9999-9999-999999999999",
      status: "queued",
      retryCount: 0,
    });
    const firstFailure = job({
      id: "88888888-8888-8888-8888-888888888888",
      briefId: "88888888-8888-8888-8888-888888888888",
      status: "failed",
      retryCount: 0,
      errorMessage: "failed on first attempt",
    });

    expect(backfillAttemptsFromLegacyJob(running).map((row) => row.status)).toEqual([
      "failed",
      "failed",
      "running",
    ]);
    expect(backfillAttemptsFromLegacyJob(cancelled).map((row) => row.status)).toEqual([
      "failed",
      "cancelled",
    ]);
    expect(backfillAttemptsFromLegacyJob(requeued).map((row) => row.status)).toEqual([
      "failed",
      "failed",
      "queued",
    ]);
    expect(backfillAttemptsFromLegacyJob(fresh)).toEqual([]);
    expect(backfillAttemptsFromLegacyJob(firstFailure).map((row) => row.status)).toEqual(["failed"]);
  });

  test("proves old/new attempt-count parity per job and in aggregate", () => {
    const jobs = [
      job({ id: "completed", briefId: "c1", status: "completed", retryCount: 1 }),
      job({ id: "running", briefId: "c2", status: "running", retryCount: 2 }),
      job({ id: "failed", briefId: "c3", status: "failed", retryCount: 3 }),
      job({ id: "fresh", briefId: "c4", status: "queued", retryCount: 0 }),
    ];

    const migrated = migrateDeliveryJobs(jobs);
    const parity = verifyMigratedAttemptCountParity(migrated);

    expect(parity.allMatch).toBe(true);
    expect(parity.aggregateLegacy).toBe(parity.aggregateAttempts);
    expect(parity.results).toHaveLength(4);
  });

  test("terminal parity ignores in-flight bookkeeping rows", () => {
    const running = job({ status: "running", retryCount: 2 });
    const attempts = backfillAttemptsFromLegacyJob(running);
    expect(verifyTerminalAttemptCountParity(running, attempts)).toBe(true);
  });

  test("in-memory job create enforces uniqueness on account, brief, and type", async () => {
    const repo = new InMemoryJobRepository();
    const input = {
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook" as const,
      metadata,
    };

    const [first, second] = await Promise.all([repo.create(input), repo.create(input)]);
    expect(second.id).toBe(first.id);
    expect(await repo.listByBrief("brief-1")).toHaveLength(1);
  });

  test("in-memory attempts reject duplicate attempt numbers", async () => {
    const attempts = new InMemoryDeliveryAttemptRepository();
    await attempts.insert({
      deliveryJobId: "job-1",
      attemptNumber: 1,
      status: "failed",
    });

    await expect(
      attempts.insert({
        deliveryJobId: "job-1",
        attemptNumber: 1,
        status: "failed",
      }),
    ).rejects.toBeInstanceOf(DuplicateAttemptNumberError);
  });
});
