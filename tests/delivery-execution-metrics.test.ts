import { describe, expect, test } from "bun:test";
import {
  countTerminalDeliveryAttempts,
  legacyBackfillRowCount,
  legacyTerminalAttemptCount,
} from "../src/application/delivery-execution-metrics";
import { verifyAttemptCountParity } from "../src/application/delivery-attempt-parity";
import type { DeliveryAttemptRecord } from "../src/domain/delivery-attempt";
import type { JobRecord } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { DuplicateAttemptNumberError } from "../src/domain/delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const baseJob: JobRecord = {
  id: "job-1",
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus",
    subscriptionId: "sub",
    endpointUrl: "https://example.com/hook",
    eventType: "test",
    payloadHash: "sha256:test",
  },
  status: "failed",
  retryCount: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseInput = {
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook" as const,
  metadata: {
    customerId: "cus",
    subscriptionId: "sub",
    endpointUrl: "https://example.com/hook",
    eventType: "test",
    payloadHash: "sha256:test",
  },
};

describe("delivery execution metrics", () => {
  test("legacy terminal counts treat a fresh queued job as zero attempts", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "queued", retryCount: 0 })).toBe(0);
  });

  test("legacy terminal counts preserve prior failures for a requeued job with retry history", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "queued", retryCount: 2 })).toBe(2);
  });

  test("legacy terminal counts include a completed recovery attempt", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "completed", retryCount: 2 })).toBe(3);
  });

  test("legacy terminal counts floor an immediate failure at one attempt", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "failed", retryCount: 0 })).toBe(1);
  });

  test("legacy backfill preserves unfinished delivery history", () => {
    expect(legacyBackfillRowCount({ ...baseJob, status: "queued", retryCount: 0 })).toBe(0);
    expect(legacyBackfillRowCount({ ...baseJob, status: "queued", retryCount: 2 })).toBe(3);
    expect(legacyBackfillRowCount({ ...baseJob, status: "running", retryCount: 2 })).toBe(3);
    expect(legacyBackfillRowCount({ ...baseJob, status: "cancelled", retryCount: 1 })).toBe(2);
    expect(legacyBackfillRowCount({ ...baseJob, status: "failed", retryCount: 0 })).toBe(1);
    expect(legacyBackfillRowCount({ ...baseJob, status: "failed", retryCount: 3 })).toBe(3);
    expect(legacyBackfillRowCount({ ...baseJob, status: "completed", retryCount: 1 })).toBe(2);
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

  test("per-job and aggregate parity match for mixed legacy rows", async () => {
    const jobs: JobRecord[] = [
      { ...baseJob, id: "fresh", status: "queued", retryCount: 0 },
      { ...baseJob, id: "requeued", status: "queued", retryCount: 2 },
      { ...baseJob, id: "running", status: "running", retryCount: 2 },
      { ...baseJob, id: "failed", status: "failed", retryCount: 3 },
      { ...baseJob, id: "completed", status: "completed", retryCount: 1 },
    ];
    const attempts = new InMemoryDeliveryAttemptRepository();

    for (const job of jobs) {
      const terminal = legacyTerminalAttemptCount(job);
      for (let n = 1; n <= terminal; n += 1) {
        await attempts.insert({
          deliveryJobId: job.id,
          attemptNumber: n,
          status: n === terminal && job.status === "completed" ? "completed" : "failed",
        });
      }
    }

    const parity = await verifyAttemptCountParity(jobs, (jobId) => attempts.listByJobId(jobId));
    expect(parity.allMatch).toBe(true);
    expect(parity.results.reduce((sum, row) => sum + row.attemptRowCount, 0)).toBe(
      jobs.reduce((sum, job) => sum + legacyTerminalAttemptCount(job), 0),
    );
  });
});

describe("delivery_jobs uniqueness and delivery_attempts constraints", () => {
  test("create collapses duplicate (account_id, brief_id, type) intent rows", async () => {
    const jobs = new InMemoryJobRepository();
    const first = await jobs.create(baseInput);
    const second = await jobs.create(baseInput);

    expect(second.id).toBe(first.id);
    expect((await jobs.findByBriefAndType(baseInput.briefId, baseInput.type)).length).toBe(1);
  });

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

  test("latest-attempt reads follow attempt_number descending", async () => {
    const attempts = new InMemoryDeliveryAttemptRepository();
    await attempts.insert({ deliveryJobId: "job-1", attemptNumber: 1, status: "failed" });
    await attempts.insert({ deliveryJobId: "job-1", attemptNumber: 3, status: "running" });
    await attempts.insert({ deliveryJobId: "job-1", attemptNumber: 2, status: "queued" });

    const latest = await attempts.findLatestByJobId("job-1");
    expect(latest?.attemptNumber).toBe(3);
    expect(latest?.status).toBe("running");
  });
});
