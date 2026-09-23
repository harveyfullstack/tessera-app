import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import type { DeliveryAttempt } from "../src/domain/delivery-attempt";
import type { JobRecord } from "../src/domain/job";

const now = new Date("2026-09-23T18:00:00Z");
const attempt: DeliveryAttempt = {
  id: "attempt-2", jobId: "job-1", accountId: "account-1", attemptNumber: 2,
  operation: "execution", status: "running", retryCount: 0, details: {},
  startedAt: new Date(now.getTime() - 300_000), createdAt: now,
};
const job: JobRecord = {
  id: "job-1", accountId: "account-1", briefId: "brief-1", type: "dispatch_webhook",
  metadata: { customerId: "customer", subscriptionId: "subscription", endpointUrl: "https://example.test",
    eventType: "test", payloadHash: "hash" },
  status: "failed", retryCount: 0, createdAt: now, updatedAt: now,
  executionSource: "attempts", latestAttempt: attempt,
};

describe("delivery display status", () => {
  test("uses latest attempt rather than stale legacy status", () => {
    expect(JobRecordService.displayStatus(job, now)).toBe("running");
  });

  test("is stuck only after strictly more than five minutes", () => {
    expect(JobRecordService.displayStatus(job, now)).toBe("running");
    expect(JobRecordService.displayStatus(job, new Date(now.getTime() + 1))).toBe("stuck");
  });

  test("defaults to queued without forward attempts", () => {
    expect(JobRecordService.displayStatus({ ...job, latestAttempt: undefined }, now)).toBe("queued");
  });

  test("rollback reads legacy status even when latest history differs", () => {
    expect(JobRecordService.displayStatus({ ...job, executionSource: "legacy" }, now)).toBe("failed");
  });

  test("missing or future start timestamps do not imply stuck", () => {
    for (const startedAt of [undefined, new Date(now.getTime() + 1)]) {
      expect(JobRecordService.displayStatus({ ...job, latestAttempt: { ...attempt, startedAt } }, now))
        .toBe("running");
    }
  });

  test("terminal attempts never become stuck", () => {
    expect(JobRecordService.displayStatus({ ...job, latestAttempt: { ...attempt, status: "completed" } },
      new Date(now.getTime() + 60_000))).toBe("completed");
  });
});

test("repository projection selects greatest sequence even with equal timestamps", async () => {
  const { InMemoryJobRepository } = await import("../src/infrastructure/repositories/in-memory-job-repository");
  const repository = new InMemoryJobRepository([], () => now);
  const service = new JobRecordService(repository);
  service.rpc.enableAccount("account-1");
  const created = await service.ensureJobRecord({ accountId: job.accountId, briefId: job.briefId,
    type: job.type, metadata: job.metadata });
  await service.markRunning(created.id, "worker");
  await service.markCompleted(created.id, { responseStatus: 200 });
  const [projected] = await service.listByBrief(job.briefId, job.accountId);
  expect(projected?.latestAttempt?.attemptNumber).toBe(2);
  expect(JobRecordService.displayStatus(projected!, now)).toBe("completed");
});

test("HTTP lists and filters derived status, then returns legacy status after rollback", async () => {
  const { InMemoryJobRepository } = await import("../src/infrastructure/repositories/in-memory-job-repository");
  const { createHttpHandler } = await import("../src/api/http-handler");
  const repository = new InMemoryJobRepository([], () => new Date(Date.now() - 300_001));
  const service = new JobRecordService(repository);
  service.rpc.enableAccount(job.accountId);
  const created = await service.ensureJobRecord({ accountId: job.accountId, briefId: job.briefId,
    type: job.type, metadata: job.metadata });
  await service.markRunning(created.id, "worker");
  const handler = createHttpHandler(service, job.accountId);
  const stuck = await (await handler(new Request(`http://localhost/briefs/${job.briefId}/jobs?status=stuck`))).json();
  expect(stuck.jobs).toHaveLength(1);
  expect(stuck.jobs[0].status).toBe("stuck");
  service.rpc.rollbackAccount(job.accountId);
  const legacy = await (await handler(new Request(`http://localhost/briefs/${job.briefId}/jobs`))).json();
  expect(legacy.jobs[0].status).toBe("running");
});
