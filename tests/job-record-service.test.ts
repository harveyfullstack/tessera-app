import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
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

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("mutates the same row across retries and overwrites terminal execution details", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    // Pre-migration pain: mutable row with no attempt history. The earlier
    // timeout error is gone the moment the next attempt starts.
    expect(final.errorMessage).toBeUndefined();
  });

  test("allocates unique, ordered attempt numbers for racing execution writes", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    await Promise.all(Array.from({ length: 20 }, (_, n) => service.markRunning(job.id, `worker-${n}`)));
    const attempts = await repo.listAttempts(job.id);
    expect(attempts.map((a) => a.attemptNumber)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
  });

  test("derives queued, latest and stuck statuses from attempt history", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    expect(await service.displayStatus(job)).toBe("queued");
    await service.markRunning(job.id, "worker-1");
    expect(await service.displayStatus(job)).toBe("running");
    const attempts = await repo.listAttempts(job.id);
    attempts[0]!.startedAt = new Date(Date.now() - 6 * 60_000);
    expect(await service.displayStatus(job)).toBe("stuck");
    await service.markFailed(job.id, "timeout");
    expect(await service.displayStatus(job)).toBe("failed");
    expect((await service.listByBrief(job.briefId))[0]?.status).toBe("failed");
  });

  test("rollback flag is evaluated per account at the RPC boundary", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo, (accountId) => accountId === "acct-1");
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-1");
    expect(await repo.listAttempts(job.id)).toEqual([]);
    expect((await repo.findById(job.id))?.status).toBe("running");
    expect(await service.displayStatus((await repo.findById(job.id))!)).toBe("running");
  });

  test("prevents duplicate intent rows under concurrent creation", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput), service.ensureJobRecord(baseInput),
    ]);
    expect(a.id).toBe(b.id);
    expect((await repo.findByBriefAndType(baseInput.briefId, baseInput.type)).length).toBe(1);
  });
});
