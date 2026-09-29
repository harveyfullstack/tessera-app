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
  test("reuses one canonical intent under racing callers, scoped to account", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);
    expect(a.id).toBe(b.id);
    const other = await service.ensureJobRecord({ ...baseInput, accountId: "acct-2" });
    expect(other.id).not.toBe(a.id);
  });

  test("appends each execution transition without losing previous errors", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "timeout", { errorBody: "timeout body" });
    await service.retry(job.id);
    const [a, b] = await Promise.all([
      service.markRunning(job.id, "worker-2"),
      service.markRunning(job.id, "worker-3"),
    ]);
    expect(a.retryCount).toBe(1);
    expect(b.retryCount).toBe(1);
    const history = await repo.attemptsForJob(job.id);
    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(history[1]?.errorBody).toBe("timeout body");
  });

  test("derives display status from latest attempt, or legacy status during rollback", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    expect(await service.displayStatus(job)).toBe("queued");
    await service.markRunning(job.id, "worker-1");
    expect(await service.displayStatus(job)).toBe("running");
    const now = Date.now;
    try {
      Date.now = () => now() + 5 * 60_000 + 1;
      expect(await service.displayStatus(job)).toBe("stuck");
    } finally {
      Date.now = now;
    }
    await service.markCompleted(job.id, { responseStatus: 200 });
    expect(await service.displayStatus(job)).toBe("completed");
    const rollback = new JobRecordService(repo, () => true);
    expect(await rollback.displayStatus({ ...job, status: "failed" })).toBe("failed");
  });

  test("account rollback uses legacy writes without adding history", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo, (account) => account === "acct-1");
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-1");
    await service.retry(job.id);
    expect((await repo.attemptsForJob(job.id)).length).toBe(0);
    expect((await repo.findById(job.id))?.retryCount).toBe(1);
  });
});
