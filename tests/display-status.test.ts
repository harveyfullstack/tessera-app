import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobMetadata } from "../src/domain/job";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

describe("JobRecordService.displayStatus", () => {
  test("returns queued when the job has no delivery attempts", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord({
      accountId: "acct-1",
      briefId: "brief-queued",
      type: "dispatch_webhook",
      metadata,
    });

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("derives status from the latest attempt number", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord({
      accountId: "acct-1",
      briefId: "brief-latest",
      type: "dispatch_webhook",
      metadata,
    });

    await service.markRunning(job.id, "worker-a");
    await service.markFailed(job.id, "timeout");
    const completed = await service.markCompleted(job.id, {
      workerId: "worker-b",
      responseStatus: 200,
    });

    expect(completed.status).toBe("completed");
    expect(await service.displayStatus(completed)).toBe("completed");
  });

  test("returns stuck when the latest attempt has been running for more than five minutes", async () => {
    const store = new InMemoryJobRepository();
    const startedAt = new Date("2026-08-21T23:00:00.000Z");
    const rpc = new DeliveryAttemptRpc(
      store,
      { isRollbackEnabled: () => false },
      () => new Date("2026-08-21T23:05:00.001Z"),
    );
    const service = new JobRecordService(store, rpc);
    const job = await service.ensureJobRecord({
      accountId: "acct-1",
      briefId: "brief-stuck",
      type: "dispatch_webhook",
      metadata,
    });

    await store.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "failed",
      errorBody: "earlier timeout",
    });
    await store.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: 2,
      status: "running",
      workerId: "worker-stuck",
      startedAt,
    });

    expect(await service.displayStatus(job)).toBe("stuck");
    expect(await service.canStartNewDelivery(job)).toBe(false);
  });

  test("falls back to jobs.status when the rollback feature flag is on", async () => {
    const store = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(store, { isRollbackEnabled: () => true });
    const service = new JobRecordService(store, rpc);
    const job = await service.ensureJobRecord({
      accountId: "acct-1",
      briefId: "brief-rollback-status",
      type: "dispatch_webhook",
      metadata,
    });

    const running = await service.markRunning(job.id, "worker-rollback");

    expect(await service.listAttempts(job.id)).toEqual([]);
    expect(await service.displayStatus(running)).toBe("running");
    expect(running.status).toBe("running");
  });
});
