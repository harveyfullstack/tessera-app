import { describe, expect, test } from "bun:test";
import { DeliverySchemaMigration } from "../src/application/delivery-schema-migration";
import { oldAttemptCountFromJob } from "../src/domain/delivery";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
} from "../src/domain/delivery-repository";
import type { JobRecord } from "../src/domain/job";
import {
  InMemoryDeliveryAttemptRepository,
  InMemoryDeliveryJobRepository,
} from "../src/infrastructure/repositories/in-memory-delivery-repository";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
} as const;

function job(overrides: Partial<JobRecord> & Pick<JobRecord, "id" | "status" | "retryCount">): JobRecord {
  const now = new Date("2026-08-13T21:54:48.970Z");
  return {
    accountId: "acct-1",
    briefId: "50ce0002-0000-4000-a001-000000000001",
    type: "dispatch_webhook",
    metadata,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stores() {
  const deliveryJobs = new InMemoryDeliveryJobRepository();
  const deliveryAttempts = new InMemoryDeliveryAttemptRepository();
  return {
    deliveryJobs,
    deliveryAttempts,
    migration: new DeliverySchemaMigration({ deliveryJobs, deliveryAttempts }),
  };
}

describe("delivery schema split", () => {
  test("migrates every unique intent row without loss or duplication", async () => {
    const { migration, deliveryJobs } = stores();
    const queued = job({
      id: "job-queued",
      status: "queued",
      retryCount: 0,
      briefId: "brief-a",
    });
    const completed = job({
      id: "job-completed",
      status: "completed",
      retryCount: 0,
      workerId: "worker-1",
      startedAt: new Date("2026-08-13T22:00:00.000Z"),
      briefId: "brief-b",
    });

    const result = await migration.migrateExistingIntentRows([queued, completed]);

    expect(result.deliveryJobs.map((row) => row.id).sort()).toEqual(["job-completed", "job-queued"]);
    expect(await deliveryJobs.listAll()).toHaveLength(2);
    expect(result.parity.matched).toBe(true);
    expect(result.parity.oldAggregate).toBe(1);
    expect(result.parity.newAggregate).toBe(1);
  });

  test("collapses duplicate (account_id, brief_id, type) races onto one delivery_job", async () => {
    const { migration, deliveryJobs, deliveryAttempts } = stores();
    const first = job({
      id: "job-first",
      status: "failed",
      retryCount: 0,
      errorMessage: "timeout",
      createdAt: new Date("2026-08-13T21:00:00.000Z"),
    });
    const duplicate = job({
      id: "job-duplicate",
      status: "running",
      retryCount: 1,
      workerId: "worker-2",
      startedAt: new Date("2026-08-13T21:10:00.000Z"),
      createdAt: new Date("2026-08-13T21:05:00.000Z"),
    });

    const result = await migration.migrateExistingIntentRows([first, duplicate]);

    expect(result.deliveryJobs).toHaveLength(1);
    expect(result.deliveryJobs[0]?.id).toBe("job-first");
    expect(await deliveryJobs.listAll()).toHaveLength(1);
    expect(await deliveryAttempts.listByDeliveryJobId("job-first")).toHaveLength(
      oldAttemptCountFromJob(first) + oldAttemptCountFromJob(duplicate),
    );
    expect(result.parity.matched).toBe(true);
    expect(result.parity.perJob[0]).toMatchObject({
      deliveryJobId: "job-first",
      oldCount: 3,
      newCount: 3,
    });
  });

  test("rejects a second delivery_jobs insert for the same intent key", async () => {
    const { deliveryJobs } = stores();
    await deliveryJobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await expect(
      deliveryJobs.create({
        accountId: "acct-1",
        briefId: "brief-1",
        type: "dispatch_webhook",
        metadata,
      }),
    ).rejects.toBeInstanceOf(DuplicateDeliveryJobError);
  });

  test("rejects a second attempt with the same (delivery_job_id, attempt_number)", async () => {
    const { deliveryJobs, deliveryAttempts } = stores();
    const deliveryJob = await deliveryJobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await deliveryAttempts.insert({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      status: "running",
    });

    await expect(
      deliveryAttempts.insert({
        deliveryJobId: deliveryJob.id,
        attemptNumber: 1,
        status: "failed",
      }),
    ).rejects.toBeInstanceOf(DuplicateDeliveryAttemptError);
  });

  test("does not cascade-delete attempts when a delivery_jobs row is removed", async () => {
    const { deliveryJobs, deliveryAttempts } = stores();
    const deliveryJob = await deliveryJobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });
    const attempt = await deliveryAttempts.insert({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      status: "completed",
      responseStatus: 200,
    });

    await deliveryJobs.deleteById(deliveryJob.id);

    expect(await deliveryJobs.findById(deliveryJob.id)).toBeNull();
    expect(await deliveryAttempts.findById(attempt.id)).toEqual(attempt);
  });

  test("indexes latest-attempt reads by descending attempt_number", async () => {
    const { deliveryJobs, deliveryAttempts } = stores();
    const deliveryJob = await deliveryJobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });
    await deliveryAttempts.insert({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      status: "failed",
    });
    await deliveryAttempts.insert({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 2,
      status: "running",
      workerId: "worker-latest",
    });

    const latest = await deliveryAttempts.findLatestByDeliveryJobId(deliveryJob.id);
    expect(latest?.attemptNumber).toBe(2);
    expect(latest?.workerId).toBe("worker-latest");

    const listedDesc = (await deliveryAttempts.listAll()).filter(
      (row) => row.deliveryJobId === deliveryJob.id,
    );
    expect(listedDesc.map((row) => row.attemptNumber)).toEqual([2, 1]);
  });

  test("proves old/new attempt-count parity per job and in aggregate before cutover", async () => {
    const { migration } = stores();
    const jobs = [
      job({
        id: "job-never-started",
        status: "queued",
        retryCount: 0,
        briefId: "brief-queued",
      }),
      job({
        id: "job-retried",
        status: "failed",
        retryCount: 2,
        errorMessage: "503",
        startedAt: new Date("2026-08-13T22:10:00.000Z"),
        briefId: "brief-retried",
      }),
      job({
        id: "job-done",
        status: "completed",
        retryCount: 0,
        workerId: "worker-3",
        startedAt: new Date("2026-08-13T22:20:00.000Z"),
        briefId: "brief-done",
      }),
    ];

    const result = await migration.migrateExistingIntentRows(jobs);

    expect(result.parity.matched).toBe(true);
    expect(result.parity.oldAggregate).toBe(0 + 3 + 1);
    expect(result.parity.newAggregate).toBe(result.parity.oldAggregate);
    expect(result.parity.perJob.every((row) => row.oldCount === row.newCount)).toBe(true);
  });
});
