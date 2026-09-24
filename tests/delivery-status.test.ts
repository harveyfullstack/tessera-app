import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput, DeliveryAttempt } from "../src/domain/job";

const input: CreateJobInput = {
  accountId: "split-account", briefId: "brief", type: "dispatch_webhook",
  metadata: { customerId: "customer", subscriptionId: "subscription", endpointUrl: "https://example.com/hook", eventType: "event", payloadHash: "hash" },
};

// Deliberately unsorted imported results exercise the read contract independently
// from the append adapter's natural insertion order.
class ImportedHistoryRepository extends InMemoryJobRepository {
  history: DeliveryAttempt[] = [];
  override async listAttempts(): Promise<DeliveryAttempt[]> {
    return structuredClone(this.history);
  }
}

const event = (number: number, status: DeliveryAttempt["status"], time: Date): DeliveryAttempt => ({
  id: `event-${number}`, deliveryJobId: "fixture", attemptNumber: number,
  status, createdAt: time, startedAt: time,
});

describe("delivery display status", () => {
  test("uses maximum event number rather than timestamps or result ordering", async () => {
    const repo = new ImportedHistoryRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(input);
    await service.execution.setEnabled(input.accountId, true);
    repo.history = [event(20, "failed", new Date(100)), event(3, "running", new Date(300)), event(8, "completed", new Date(200))];
    expect(await service.displayStatus(job.id)).toBe("failed");
    expect((await service.listByBrief(input.briefId))[0]!.status).toBe("failed");
  });

  test("empty split history is queued and missing jobs fail explicitly", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(input);
    await service.execution.setEnabled(input.accountId, true);
    expect(await service.displayStatus(job.id)).toBe("queued");
    await expect(service.displayStatus("missing")).rejects.toThrow("Job not found");
  });

  test("stuck threshold is strictly more than five minutes and requires startedAt", async () => {
    const repo = new ImportedHistoryRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(input);
    await service.execution.setEnabled(input.accountId, true);
    const started = new Date("2026-09-24T12:00:00Z");
    repo.history = [event(1, "running", started)];
    expect(await service.displayStatus(job.id, new Date(started.getTime() + 300000))).toBe("running");
    expect(await service.displayStatus(job.id, new Date(started.getTime() + 300001))).toBe("stuck");
    expect((await service.listByBrief(input.briefId, new Date(started.getTime() + 300001)))[0]!.status).toBe("stuck");
    expect(await service.canStartNewDelivery(job.id)).toBe(false);
    repo.history = [{ ...event(2, "running", started), startedAt: undefined }];
    expect(await service.displayStatus(job.id, new Date(started.getTime() + 900000))).toBe("running");
    repo.history = [event(3, "failed", started)];
    expect(await service.displayStatus(job.id, new Date(started.getTime() + 900000))).toBe("failed");
  });

  test("flag switches immediately and only changes the selected account", async () => {
    const repo = new ImportedHistoryRepository();
    const service = new JobRecordService(repo);
    const first = await service.ensureJobRecord(input);
    const second = await service.ensureJobRecord({ ...input, accountId: "legacy-account" });
    repo.history = [event(1, "failed", new Date())];
    expect(await service.displayStatus(first.id)).toBe("queued");
    await service.execution.setEnabled(input.accountId, true);
    expect(await service.displayStatus(first.id)).toBe("failed");
    expect(await service.displayStatus(second.id)).toBe("queued");
    await service.execution.setEnabled(input.accountId, false);
    expect(await service.displayStatus(first.id)).toBe("queued");
    await service.execution.setEnabled(input.accountId, true);
    expect(await service.displayStatus(first.id)).toBe("failed");
  });
});
