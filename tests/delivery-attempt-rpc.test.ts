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

describe("DeliveryAttemptRpc", () => {
  test("appends an attempt for each execution write and keeps prior error bodies", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s", {
      errorBody: "endpoint timeout after 30s",
    });
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-us-east-07");

    const attempts = await service.listAttempts(job.id);
    expect(attempts.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(attempts.some((attempt) => attempt.errorBody === "endpoint timeout after 30s")).toBe(
      true,
    );
    expect(attempts.filter((attempt) => attempt.status === "running")).toHaveLength(2);
  });

  test("assigns monotonically increasing attempt numbers to racing callers", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    await Promise.all([
      service.markRunning(job.id, "worker-a"),
      service.markRunning(job.id, "worker-b"),
      service.markFailed(job.id, "race fail"),
    ]);

    const attempts = await service.listAttempts(job.id);
    const numbers = attempts.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
    expect(new Set(numbers).size).toBe(3);
  });

  test("skips attempt inserts when the rollback flag is on for the account", async () => {
    const repo = new InMemoryJobRepository();
    const flags = new DeliveryRollbackFlags();
    flags.enableRollback(baseInput.accountId);
    const service = new JobRecordService(repo, flags);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-rollback");
    const failed = await service.markFailed(job.id, "legacy overwrite");

    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("legacy overwrite");
    expect(await service.listAttempts(job.id)).toEqual([]);
  });
});
