import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput, JobRecord } from "../src/domain/job";

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
  test("concurrent intent creation is unique per account, brief and type", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const jobs = await Promise.all(Array.from({ length: 30 }, () => service.ensureJobRecord(baseInput)));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    const other = await service.ensureJobRecord({ ...baseInput, accountId: "acct-2" });
    expect(other.id).not.toBe(jobs[0]!.id);
    const otherType = await service.ensureJobRecord({ ...baseInput, type: "drain_dlq" });
    expect(otherType.id).not.toBe(jobs[0]!.id);
  });

  test("preserves complete, detached history across retry and rollback", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    const rollout = await service.execution.setEnabled(baseInput.accountId, true);
    expect(rollout.rollbackUntil!.getTime() - rollout.enabledAt!.getTime()).toBe(14 * 86400000);
    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "timeout", { responseStatus: 503, responseLatencyMs: 30000, errorBody: "endpoint timeout" });
    await service.execution.setEnabled(baseInput.accountId, false);
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-2");
    const completed = await service.markCompleted(job.id, { responseStatus: 200, responseLatencyMs: 42 });
    const attempts = await repo.listAttempts(job.id);
    expect(attempts.map((a) => a.status)).toEqual(["running", "failed", "queued", "running", "completed"]);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts[1]).toMatchObject({ workerId: "worker-1", errorBody: "endpoint timeout", responseStatus: 503, responseLatencyMs: 30000 });
    expect(attempts[1]!.startedAt).toBeInstanceOf(Date);
    expect(attempts[1]!.completedAt).toBeInstanceOf(Date);
    expect(await repo.listLegacyAttempts(job.id)).toEqual(attempts);
    expect(completed.retryCount).toBe(1);
    attempts[1]!.errorBody = "mutated";
    attempts[1]!.createdAt.setTime(0);
    completed.metadata.endpointUrl = "mutated";
    expect((await repo.listAttempts(job.id))[1]!.errorBody).toBe("endpoint timeout");
    expect((await repo.listAttempts(job.id))[1]!.createdAt.getTime()).toBeGreaterThan(0);
    expect((await repo.findIntent(job.id))!.metadata.endpointUrl).toBe(baseInput.metadata.endpointUrl);
  });

  test("allocates contiguous event numbers under concurrency and ignores caller numbers", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    await Promise.all(Array.from({ length: 40 }, () => service.markFailed(job.id, "failure", { attemptNumber: 900 })));
    expect((await repo.listAttempts(job.id)).map((a) => a.attemptNumber)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect((await repo.listLegacyAttempts(job.id)).length).toBe(40);
  });

  test("racing starts allow one execution and record only the accepted transition", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    const outcomes = await Promise.allSettled([service.markRunning(job.id, "a"), service.markRunning(job.id, "b")]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await repo.listAttempts(job.id)).toHaveLength(1);
  });

  test("legacy accounts block cutover but keep complete prospective history", async () => {
    const now = new Date();
    const legacy: JobRecord = { ...baseInput, id: "legacy", status: "failed", retryCount: 9, createdAt: now, updatedAt: now };
    const repo = new InMemoryJobRepository([legacy]);
    const service = new JobRecordService(repo);
    await expect(service.execution.setEnabled(baseInput.accountId, true)).rejects.toThrow("cutover blocked");
    await service.markRunning(legacy.id, "replay-worker");
    await service.markCompleted(legacy.id, { responseStatus: 200, responseLatencyMs: 70 });
    expect(await repo.listAttempts(legacy.id)).toHaveLength(0);
    expect((await repo.listLegacyAttempts(legacy.id))[1]).toMatchObject({ workerId: "replay-worker", responseStatus: 200, responseLatencyMs: 70 });
    await expect(service.execution.setEnabled(baseInput.accountId, true)).rejects.toThrow("cutover blocked");
    expect((await service.execution.setEnabled("other-account", true)).enabled).toBe(true);
    expect((await service.execution.getRollout(baseInput.accountId)).enabled).toBe(false);
  });

  test("missing jobs do not create events", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    await expect(service.markRunning("missing", "worker")).rejects.toThrow("Job not found");
    expect(await repo.listAttempts("missing")).toEqual([]);
  });
});
