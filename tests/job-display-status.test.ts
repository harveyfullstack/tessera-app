import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { AccountRollbackFlags, NoRollbackFlags } from "../src/domain/delivery-rollback";
import type { DeliveryAttempt } from "../src/domain/delivery-schema";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const input: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

const now = new Date("2026-04-01T00:10:00.000Z");
const fiveMinutesMs = 5 * 60 * 1000;

describe("JobRecordService.displayStatus", () => {
  test("returns queued when the job has no attempts", async () => {
    const attempts = new InMemoryDeliveryAttemptStore();
    const jobs = new InMemoryJobRepository();
    const service = new JobRecordService(jobs, attempts, new NoRollbackFlags(), () => now);
    const job = await jobs.create({ ...input, });
    await jobs.updateExecution(job.id, { status: "failed", errorMessage: "gone" });
    const failed = await jobs.findById(job.id);

    expect(await service.displayStatus(failed!)).toBe("queued");
  });

  test("uses the latest attempt and marks a run stuck after five minutes", async () => {
    const attempts = new InMemoryDeliveryAttemptStore();
    const jobs = new InMemoryJobRepository();
    const service = new JobRecordService(jobs, attempts, new NoRollbackFlags(), () => now);
    const job = await jobs.create(input);
    const running: DeliveryAttempt = {
      id: "attempt-1",
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "running",
      startedAt: new Date(now.getTime() - fiveMinutesMs),
    };
    const newer: DeliveryAttempt = {
      id: "attempt-2",
      deliveryJobId: job.id,
      attemptNumber: 2,
      status: "running",
      startedAt: new Date(now.getTime() - fiveMinutesMs - 1),
    };
    await attempts.insert(running);

    expect(await service.displayStatus(job)).toBe("running");
    expect(await service.canStartNewDelivery(job)).toBe(false);

    await attempts.insert(newer);
    expect(await service.displayStatus(job)).toBe("stuck");
    expect(await service.canStartNewDelivery(job)).toBe(true);
  });

  test("falls back to the legacy job status when rollback is on", async () => {
    const attempts = new InMemoryDeliveryAttemptStore();
    const jobs = new InMemoryJobRepository();
    const service = new JobRecordService(jobs, attempts, new AccountRollbackFlags(new Set(["acct-1"])), () => now);
    const created = await jobs.create(input);
    await jobs.updateExecution(created.id, { status: "failed", errorMessage: "legacy row" });
    const job = await jobs.findById(created.id);
    if (!job) {
      throw new Error("missing job");
    }
    await attempts.insert({
      id: "attempt-1",
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "completed",
    });

    expect(await service.displayStatus(job)).toBe("failed");
  });

  test("records startedAt on a running attempt from the RPC clock", async () => {
    const attempts = new InMemoryDeliveryAttemptStore();
    const jobs = new InMemoryJobRepository();
    const service = new JobRecordService(jobs, attempts, new NoRollbackFlags(), () => now);
    const job = await service.ensureJobRecord(input);

    await service.markRunning(job.id, "worker-a");
    const latest = await attempts.latest(job.id);

    expect(latest?.startedAt).toEqual(now);
    expect(await service.displayStatus(job)).toBe("running");
  });
});
