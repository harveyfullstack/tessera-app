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

describe("DeliveryAttemptRpc", () => {
  test("inserts a new delivery_attempts row for running, failed, completed, and retry", async () => {
    const store = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(store);
    const job = await store.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await rpc.markRunning(job.id, "worker-a");
    await rpc.markFailed(job.id, "timeout", {
      workerId: "worker-a",
      responseStatus: 503,
      errorBody: "endpoint returned 503 after 30s timeout",
    });
    await rpc.retry(job.id);
    await rpc.markRunning(job.id, "worker-b");
    await rpc.markCompleted(job.id, {
      workerId: "worker-b",
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    const attempts = await rpc.listAttempts(job.id);
    expect(attempts.map((row) => row.attemptNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(attempts.map((row) => row.status)).toEqual([
      "completed",
      "running",
      "queued",
      "failed",
      "running",
    ]);
    expect(attempts.find((row) => row.status === "failed")?.responseStatus).toBe(503);
  });

  test("assigns monotonically increasing attempt numbers to racing callers", async () => {
    const store = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(store);
    const job = await store.create({
      accountId: "acct-1",
      briefId: "brief-race",
      type: "dispatch_webhook",
      metadata,
    });

    await Promise.all([
      rpc.markRunning(job.id, "worker-a"),
      rpc.markFailed(job.id, "boom"),
      rpc.retry(job.id),
      rpc.markCompleted(job.id, { workerId: "worker-c", responseStatus: 200 }),
    ]);

    const attempts = await rpc.listAttempts(job.id);
    const numbers = attempts.map((row) => row.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
    expect(new Set(numbers).size).toBe(4);
  });

  test("is the only rollback-flag boundary and skips attempt inserts when rollback is on", async () => {
    const store = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(store, { isRollbackEnabled: () => true });
    const service = new JobRecordService(store, rpc);
    const job = await service.ensureJobRecord({
      accountId: "acct-1",
      briefId: "brief-rollback",
      type: "dispatch_webhook",
      metadata,
    });

    await service.markRunning(job.id, "worker-rollback");
    const failed = await service.markFailed(job.id, "rolled back path");

    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("rolled back path");
    expect(await service.listAttempts(job.id)).toEqual([]);
  });
});
