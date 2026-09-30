import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
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

  test("concurrent ensures reuse one account-scoped canonical intent", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const rows = await Promise.all(Array.from({ length: 20 }, () => service.ensureJobRecord(baseInput)));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const otherAccount = await service.ensureJobRecord({ ...baseInput, accountId: "other" });
    expect(otherAccount.deliveryJobId).not.toBe(rows[0]!.deliveryJobId);
  });
});

function pilot() {
  const repo = new InMemoryJobRepository();
  const pilotAccounts = new Set([baseInput.accountId]);
  const rollbackAccounts = new Set<string>();
  const rpc = new DeliveryAttemptRpc(repo, { pilotAccounts, rollbackAccounts });
  return { repo, pilotAccounts, rollbackAccounts, service: new JobRecordService(repo, rpc) };
}

describe("DeliveryAttemptRpc", () => {
  test("records each execution mutation and ignores caller attempt numbers", async () => {
    const { repo, service } = pilot();
    const job = await service.ensureJobRecord(baseInput);
    const intent = await repo.findDeliveryJob(job.deliveryJobId);
    await service.markRunning(job.id, "worker-a");
    await service.markFailed(job.id, "timeout", { attemptNumber: 99, responseStatus: 503, errorBody: "original body" });
    await service.retry(job.id);
    await service.markCompleted(job.id, { responseStatus: 200, responseLatencyMs: 18 });
    const history = await repo.listAttempts(job.deliveryJobId);
    expect(history.map((row) => row.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(history.map((row) => row.status)).toEqual(["running", "failed", "queued", "completed"]);
    expect(history[1]!.errorBody).toBe("original body");
    expect(history[3]!.responseLatencyMs).toBe(18);
    expect(await repo.findDeliveryJob(job.deliveryJobId)).toEqual(intent);
    expect((await repo.findById(job.id))!.status).toBe("completed");
    history[1]!.errorBody = "tampered";
    intent!.metadata.endpointUrl = "tampered";
    expect((await repo.listAttempts(job.deliveryJobId))[1]!.errorBody).toBe("original body");
    expect((await repo.findDeliveryJob(job.deliveryJobId))!.metadata.endpointUrl).toBe(baseInput.metadata.endpointUrl);
  });

  test("racing RPC instances allocate one monotonic sequence across legacy duplicates", async () => {
    const { repo, service } = pilot();
    const duplicate = await repo.create(baseInput);
    const job = await repo.create(baseInput);
    expect(duplicate.id).not.toBe(job.id);
    expect(duplicate.deliveryJobId).toBe(job.deliveryJobId);
    const other = new JobRecordService(repo, new DeliveryAttemptRpc(repo, {
      pilotAccounts: new Set([baseInput.accountId]), rollbackAccounts: new Set(),
    }));
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      index % 2 ? service.markRunning(job.id, "one") : other.markFailed(duplicate.id, "two")));
    const rows = await repo.listAttempts(job.deliveryJobId);
    expect(rows.map((row) => row.attemptNumber)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(new Set(rows.map((row) => row.id)).size).toBe(50);
  });

  test("ships disabled, records forward only, and rollback wins over pilot", async () => {
    const { repo, service, rollbackAccounts } = pilot();
    const job = await repo.create(baseInput);
    const legacy = new JobRecordService(repo);
    await legacy.markFailed(job.id, "before cutover");
    expect(await repo.listAttempts(job.deliveryJobId)).toEqual([]);
    await service.markRunning(job.id, "pilot");
    rollbackAccounts.add(baseInput.accountId);
    await service.markCompleted(job.id, {});
    expect((await repo.findById(job.id))!.status).toBe("completed");
    expect((await repo.listAttempts(job.deliveryJobId)).length).toBe(1);
    rollbackAccounts.clear();
    await service.retry(job.id);
    expect((await repo.listAttempts(job.deliveryJobId)).map((row) => row.attemptNumber)).toEqual([1, 2]);
    const outside = await service.ensureJobRecord({ ...baseInput, accountId: "outside-pilot" });
    await service.markRunning(outside.id, "legacy");
    expect(await repo.listAttempts(outside.deliveryJobId)).toEqual([]);
  });

  test("missing jobs and invalid attempt details leave history and rollback state unchanged", async () => {
    const { repo, service } = pilot();
    await expect(service.markRunning("missing", "worker")).rejects.toThrow();
    await expect(service.markFailed("missing", "error")).rejects.toThrow();
    await expect(service.markCompleted("missing", {})).rejects.toThrow();
    await expect(service.retry("missing")).rejects.toThrow();
    const job = await repo.create(baseInput);
    await expect(service.markCompleted(job.id, { responseStatus: 999 })).rejects.toThrow();
    expect(await repo.listAttempts(job.deliveryJobId)).toEqual([]);
    expect(await repo.findById(job.id)).toEqual(job);
  });
});
