import { describe, expect, test } from "bun:test";
import { backfillDeliveryAttempts } from "../src/application/delivery-attempt-backfill";
import { verifyAttemptCountParity } from "../src/application/delivery-attempt-parity";
import {
  backfillAttemptRowCount,
  backfillAttemptStatuses,
  countTerminalDeliveryAttempts,
  legacyTerminalAttemptCount,
} from "../src/application/delivery-execution-metrics";
import { DuplicateAttemptNumberError } from "../src/domain/delivery-attempt-repository";
import type { DeliveryAttemptRecord } from "../src/domain/delivery-attempt";
import type { JobRecord, JobStatus } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "cus",
  subscriptionId: "sub",
  endpointUrl: "https://example.com/hook",
  eventType: "test",
  payloadHash: "sha256:test",
} as const;

function job(overrides: Partial<JobRecord> & { id: string; status: JobStatus; retryCount: number }): JobRecord {
  const now = new Date();
  return {
    accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    briefId: overrides.briefId ?? overrides.id,
    type: "dispatch_webhook",
    metadata,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("delivery_attempts uniqueness and backfill parity", () => {
  test("rejects duplicate attempt numbers for the same delivery job", async () => {
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

  test("enforces uniqueness on (accountId, briefId, type) under concurrent creates", async () => {
    const jobs = new InMemoryJobRepository();
    const input = {
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook" as const,
      metadata,
    };

    const [a, b] = await Promise.all([jobs.create(input), jobs.create(input)]);
    expect(a.id).toBe(b.id);
  });

  test("legacy and backfill counts stay aligned per job and in aggregate", async () => {
    const fixtures = [
      job({ id: "canonical-failed", status: "failed", retryCount: 3 }),
      job({ id: "completed-recovery", status: "completed", retryCount: 1 }),
      job({ id: "running-with-history", status: "running", retryCount: 2 }),
      job({ id: "cancelled-with-history", status: "cancelled", retryCount: 1 }),
      job({ id: "requeued-with-history", status: "queued", retryCount: 2 }),
      job({ id: "fresh-queued", status: "queued", retryCount: 0 }),
      job({ id: "failed-first-try", status: "failed", retryCount: 0 }),
    ];

    expect(backfillAttemptStatuses(fixtures[2]!)).toEqual(["failed", "failed", "running"]);
    expect(backfillAttemptStatuses(fixtures[3]!)).toEqual(["failed", "cancelled"]);
    expect(backfillAttemptStatuses(fixtures[4]!)).toEqual(["failed", "failed", "queued"]);
    expect(backfillAttemptStatuses(fixtures[5]!)).toEqual([]);
    expect(backfillAttemptStatuses(fixtures[6]!)).toEqual(["failed"]);

    const attempts = new InMemoryDeliveryAttemptRepository();
    for (const fixture of fixtures) {
      await backfillDeliveryAttempts(fixture, attempts);
    }

    const parity = await verifyAttemptCountParity(fixtures, attempts);
    expect(parity.allMatch).toBe(true);
    expect(parity.aggregateMatches).toBe(true);
    expect(parity.aggregateLegacyAttemptCount).toBe(parity.aggregateAttemptRowCount);

    expect(legacyTerminalAttemptCount(fixtures[0]!)).toBe(3);
    expect(legacyTerminalAttemptCount(fixtures[1]!)).toBe(2);
    expect(legacyTerminalAttemptCount(fixtures[2]!)).toBe(2);
    expect(legacyTerminalAttemptCount(fixtures[5]!)).toBe(0);
    expect(legacyTerminalAttemptCount(fixtures[6]!)).toBe(1);

    expect(backfillAttemptRowCount(fixtures[2]!)).toBe(3);
    expect(await attempts.countByJobId("running-with-history")).toBe(3);
    expect(await attempts.countByJobId("fresh-queued")).toBe(0);
  });

  test("parity check rejects over-counted diagnostic attempt rows", async () => {
    const fixture = job({ id: "job-overcount", status: "completed", retryCount: 0 });
    const attempts = new InMemoryDeliveryAttemptRepository();

    await attempts.insert({
      deliveryJobId: fixture.id,
      attemptNumber: 1,
      status: "completed",
    });
    await attempts.insert({
      deliveryJobId: fixture.id,
      attemptNumber: 2,
      status: "completed",
    });

    const parity = await verifyAttemptCountParity([fixture], attempts);
    expect(parity.allMatch).toBe(false);
    expect(parity.aggregateMatches).toBe(false);
  });

  test("terminal attempt rows exclude lifecycle bookkeeping", () => {
    const attempts: DeliveryAttemptRecord[] = [
      {
        id: "1",
        deliveryJobId: "job-1",
        attemptNumber: 4,
        status: "running",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "2",
        deliveryJobId: "job-1",
        attemptNumber: 3,
        status: "queued",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "3",
        deliveryJobId: "job-1",
        attemptNumber: 2,
        status: "failed",
        errorBody: "body-2",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "4",
        deliveryJobId: "job-1",
        attemptNumber: 1,
        status: "failed",
        errorBody: "body-1",
        startedAt: new Date(),
        createdAt: new Date(),
      },
    ];

    expect(countTerminalDeliveryAttempts(attempts)).toBe(2);
  });
});
