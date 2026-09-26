import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { DeliveryAttemptRepository } from "../src/domain/delivery-attempt-repository";
import type { JobRepository } from "../src/domain/job-repository";
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
    const service = createService(repo).service;

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("identifies jobs by account and exact endpoint URL", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo).service;
    const first = await service.ensureJobRecord(baseInput);
    const sameEndpoint = await service.ensureJobRecord({
      ...baseInput,
      metadata: { ...baseInput.metadata, payloadHash: "sha256:new-payload" },
    });
    const trailingSlash = await service.ensureJobRecord({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        endpointUrl: `${baseInput.metadata.endpointUrl}/`,
      },
    });
    const differentCase = await service.ensureJobRecord({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        endpointUrl: baseInput.metadata.endpointUrl.toUpperCase(),
      },
    });
    const differentAccount = await service.ensureJobRecord({
      ...baseInput,
      accountId: "acct-2",
    });

    expect(sameEndpoint.id).toBe(first.id);
    expect(trailingSlash.id).not.toBe(first.id);
    expect(differentCase.id).not.toBe(first.id);
    expect(differentAccount.id).not.toBe(first.id);
  });

  test("appends execution writes and projects the latest attempt across retries", async () => {
    const repo = new InMemoryJobRepository();
    const { service, attempts } = createService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();
    expect(
      (await attempts.listByJobId(job.id)).map((attempt) => attempt.attemptNumber),
    ).toEqual([1, 2, 3, 4]);
  });

  test("assigns unique sequential numbers when execution writes race", async () => {
    const repo = new InMemoryJobRepository();
    const { service, attempts } = createService(repo);
    const job = await service.ensureJobRecord(baseInput);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.markRunning(job.id, `worker-${index}`),
      ),
    );

    expect(
      (await attempts.listByJobId(job.id)).map((attempt) => attempt.attemptNumber),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("uses legacy writes when the account rollback flag is enabled", async () => {
    const repo = new InMemoryJobRepository();
    const { service, attempts } = createService(repo, () => true);
    const job = await service.ensureJobRecord(baseInput);

    const updated = await service.markRunning(job.id, "worker-us-east-04");

    expect(updated.status).toBe("running");
    expect(await attempts.listByJobId(job.id)).toEqual([]);
    expect(await service.displayStatus(updated)).toBe("running");
  });

  test("displays queued when there are no attempts outside rollback mode", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo).service;
    const job = await service.ensureJobRecord(baseInput);
    const completedJob = await repo.updateExecution(job.id, {
      status: "completed",
    });

    expect(await service.displayStatus(completedJob)).toBe("queued");
  });

  test("displays the latest attempt status", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo).service;
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");

    expect(await service.displayStatus(job)).toBe("running");
  });

  test("displays stuck for a running attempt older than five minutes", async () => {
    const repo = new InMemoryJobRepository();
    const { service, attempts } = createService(repo);
    const job = await service.ensureJobRecord(baseInput);
    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000 - 1),
    });

    expect(await service.displayStatus(job)).toBe("stuck");
  });

  test("reuses the canonical job when endpoint requests race", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo).service;

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).toBe(b.id);
    expect((await repo.listByBrief(baseInput.briefId)).length).toBe(1);
  });
});

function createService(
  repo: JobRepository,
  rollbackEnabled?: (accountId: string) => boolean,
): { service: JobRecordService; attempts: DeliveryAttemptRepository } {
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(repo, attempts, rollbackEnabled);
  return { service: new JobRecordService(repo, rpc), attempts };
}
