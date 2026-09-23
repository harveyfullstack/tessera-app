import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const baseInput: CreateJobInput = {
  accountId: "acct-1", briefId: "brief-1", type: "dispatch_webhook",
  metadata: { customerId: "customer", subscriptionId: "subscription",
    endpointUrl: "https://example.com/hooks", eventType: "anomaly.detected", payloadHash: "hash" },
};

describe("JobRecordService", () => {
  test("concurrent callers reuse one account-scoped immutable intent", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const rows = await Promise.all(Array.from({ length: 50 }, () => service.ensureJobRecord(baseInput)));
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const other = await service.ensureJobRecord({ ...baseInput, accountId: "acct-2" });
    expect(other.id).not.toBe(rows[0]!.id);
    const first = rows[0]!;
    const replay = await service.ensureJobRecord({ ...baseInput, metadata: { ...baseInput.metadata, endpointUrl: "https://changed.test" } });
    expect(replay.metadata).toEqual(baseInput.metadata);
    first.metadata.endpointUrl = "https://mutated.test";
    expect((await repo.getIntent(first.id))!.metadata).toEqual(baseInput.metadata);
  });

  test("each write retains full details without mutating intent or earlier history", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);
    const intent = await repo.getIntent(job.id);
    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "timeout", { responseStatus: 503, errorBody: "unavailable", responseLatencyMs: 30000 });
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-2");
    await service.markCompleted(job.id, { responseStatus: 200, responseLatencyMs: 20 });
    const history = await service.listAttempts(job.id);
    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(history[1]!.details.errorBody).toBe("unavailable");
    expect(history[1]!.errorMessage).toBe("timeout");
    expect(history[4]!.retryCount).toBe(1);
    expect(await repo.getIntent(job.id)).toEqual(intent);
    history[1]!.details.errorBody = "changed";
    expect((await service.listAttempts(job.id))[1]!.details.errorBody).toBe("unavailable");
  });

  test("concurrent writes allocate unique sequences and retries atomically", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord(baseInput);
    const rows = await Promise.all(Array.from({ length: 50 }, () => service.retry(job.id)));
    expect(rows.map((row) => row.latestAttempt!.attemptNumber)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(rows.at(-1)!.retryCount).toBe(50);
  });

  test("only one concurrent worker can start delivery", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord(baseInput);
    const results = await Promise.allSettled([service.markRunning(job.id, "one"), service.markRunning(job.id, "two")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await service.listAttempts(job.id)).toHaveLength(1);
  });

  test("missing execution writes fail without creating history", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    await expect(service.retry("missing")).rejects.toThrow("Job not found");
    await expect(service.markCompleted("missing", {})).rejects.toThrow("Job not found");
  });

  test("a stale DLQ decision cannot overwrite a newer execution", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord(baseInput);
    const failed = await service.markFailed(job.id, "failure");
    await service.markRunning(job.id, "recovery");
    const result = await service.markDeadLettered(job.id, failed.latestAttempt!.attemptNumber);
    expect(result.status).toBe("running");
    expect(await service.listAttempts(job.id)).toHaveLength(2);
  });
});
