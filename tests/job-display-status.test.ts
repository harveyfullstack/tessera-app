import { describe, expect, test } from "bun:test";
import { DeliveryRollbackFlags } from "../src/application/delivery-rollback-flags";
import { JobRecordService } from "../src/application/job-record-service";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

describe("JobRecordService.displayStatus", () => {
  test("returns queued when the job has no attempts", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("derives status from MAX(attempt_number) and marks long-running attempts stuck", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    await repo.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "failed",
      errorBody: "timeout",
    });
    await repo.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: 2,
      status: "running",
      workerId: "worker-stale",
      startedAt: new Date(Date.now() - JobRecordService.STUCK_ATTEMPT_MS - 1),
    });

    expect(await service.displayStatus(job)).toBe("stuck");
  });

  test("falls back to jobs.status when the rollback flag is on", async () => {
    const repo = new InMemoryJobRepository();
    const flags = new DeliveryRollbackFlags();
    const service = new JobRecordService(repo, flags);
    const job = await service.ensureJobRecord(baseInput);

    await repo.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "running",
      startedAt: new Date(Date.now() - JobRecordService.STUCK_ATTEMPT_MS - 5_000),
    });
    const snapshot = await repo.updateExecution(job.id, { status: "completed" });

    expect(await service.displayStatus(snapshot)).toBe("stuck");

    flags.enableRollback(job.accountId);
    expect(await service.displayStatus(snapshot)).toBe("completed");
  });
});
