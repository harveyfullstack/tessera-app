import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput, JobRecord } from "../src/domain/job";

const input: CreateJobInput = {
  accountId: "pilot", briefId: "brief", type: "dispatch_webhook",
  metadata: { customerId: "c", subscriptionId: "s", endpointUrl: "https://example.test",
    eventType: "test", payloadHash: "hash" },
};
const legacy: JobRecord = { ...input, id: "legacy", status: "failed", retryCount: 7,
  errorMessage: "historic timeout", createdAt: new Date(0), updatedAt: new Date(1) };

describe("DeliveryAttemptRpc rollout", () => {
  test("captures only provable forward history and preserves legacy snapshots", async () => {
    const repo = new InMemoryJobRepository([legacy]);
    const service = new JobRecordService(repo);
    expect(await repo.listAttempts(legacy.id)).toEqual([]);
    expect(await repo.getLegacySnapshot(legacy.id)).toEqual(legacy);
    await service.markRunning(legacy.id, "worker");
    const row = await service.markCompleted(legacy.id, { responseStatus: 200 });
    expect(row.executionSource).toBe("legacy");
    expect(service.rpc.getParity(input.accountId)).toMatchObject({ legacyEventCount: 2, attemptCount: 2, matches: true });
    expect(await repo.getLegacySnapshot(legacy.id)).toEqual(legacy);
    expect((await repo.getIntent(legacy.id))!).not.toHaveProperty("status");
  });

  test("flags isolate accounts, rollback retains new history and continued parity", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const pilot = await service.ensureJobRecord(input);
    const control = await service.ensureJobRecord({ ...input, accountId: "control" });
    service.rpc.enableAccount("pilot");
    expect((await service.markFailed(pilot.id, "failure")).executionSource).toBe("attempts");
    expect((await service.markFailed(control.id, "failure")).executionSource).toBe("legacy");
    service.rpc.rollbackAccount("pilot");
    expect((await service.retry(pilot.id)).executionSource).toBe("legacy");
    expect(await service.listAttempts(pilot.id)).toHaveLength(2);
    expect(service.rpc.getParity("pilot").matches).toBe(true);
  });

  test("rollback is executable through the full fourteen-day boundary", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const repo = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(repo, () => now);
    rpc.enableAccount("pilot");
    rpc.enableAccount("late");
    now = new Date("2026-01-15T00:00:00Z");
    expect(rpc.rollbackAccount("pilot").enabled).toBe(false);
    now = new Date(now.getTime() + 1);
    expect(rpc.rollbackAccount("late").enabled).toBe(false);
    expect(rpc.source("late")).toBe("legacy");
  });

  test("unresolved duplicates are retained and block account cutover", async () => {
    const repo = new InMemoryJobRepository([legacy, { ...legacy, id: "duplicate" }]);
    const service = new JobRecordService(repo);
    expect(await repo.listByBrief(input.briefId)).toHaveLength(2);
    expect(await repo.getLegacySnapshot("duplicate")).not.toBeNull();
    expect(await repo.getIntent("legacy")).toBeNull();
    expect(service.rpc.getParity("pilot")).toMatchObject({ unresolvedDuplicateKeys: 1, matches: false });
    expect(() => service.rpc.enableAccount("pilot")).toThrow("cutover blocked");
    await expect(service.ensureJobRecord(input)).rejects.toThrow("duplicate");
    await expect(service.retry("legacy")).rejects.toThrow("duplicate");
  });
});
