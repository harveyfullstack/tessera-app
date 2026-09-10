import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import {
  DELIVERY_ATTEMPTS_ROLLBACK_FLAG,
  StaticFeatureFlagStore,
} from "../src/application/feature-flags";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

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

describe("DeliveryAttemptRpc", () => {
  test("inserts a new delivery_attempts row for each execution write", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "503", {
      workerId: "worker-1",
      responseStatus: 503,
      responseLatencyMs: 30_000,
      errorBody: "endpoint returned 503",
    });
    await service.retry(job.id);
    await service.markCompleted(job.id, {
      workerId: "worker-2",
      responseStatus: 200,
      responseLatencyMs: 120,
    });

    const attempts = await repo.listAttempts(job.id);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([4, 3, 2, 1]);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "completed",
      "queued",
      "failed",
      "running",
    ]);
  });

  test("assigns monotonically increasing attempt numbers to racing callers", async () => {
    const repo = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(repo);
    const job = await repo.create(baseInput);

    await Promise.all([
      rpc.markRunning(job.id, "worker-a"),
      rpc.markRunning(job.id, "worker-b"),
      rpc.markFailed(job.id, "lost the race"),
    ]);

    const attempts = await repo.listAttempts(job.id);
    expect(attempts.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(attempts.map((attempt) => attempt.attemptNumber)).size).toBe(3);
  });

  test("skips attempt inserts when the rollback feature flag is on", async () => {
    const repo = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(
      repo,
      new StaticFeatureFlagStore(new Set([DELIVERY_ATTEMPTS_ROLLBACK_FLAG])),
    );
    const service = new JobRecordService(repo, rpc);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "timeout");
    await service.retry(job.id);

    expect(await repo.listAttempts(job.id)).toEqual([]);
    const updated = await repo.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.retryCount).toBe(1);
  });
});
