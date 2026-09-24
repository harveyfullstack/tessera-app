import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const testJobInput: CreateJobInput = {
  accountId: "acct-test-rpc",
  briefId: "7f000002-0000-4000-a000-00000000000c",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_123",
    subscriptionId: "sub_123",
    endpointUrl: "https://example.com/webhook",
    eventType: "invoice.paid",
    payloadHash: "sha256:abc",
  },
};

describe("DeliveryAttemptRpc", () => {
  test("inserts a new delivery_attempts row for markRunning, retry, and markCompleted", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(testJobInput);

    await service.markRunning(job.id, "worker-1");
    let attempts = await repo.listDeliveryAttempts(job.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.attemptNumber).toBe(1);
    expect(attempts[0]!.status).toBe("running");
    expect(attempts[0]!.workerId).toBe("worker-1");

    await service.retry(job.id);
    attempts = await repo.listDeliveryAttempts(job.id);
    expect(attempts.length).toBe(2);
    expect(attempts[1]!.attemptNumber).toBe(2);
    expect(attempts[1]!.status).toBe("queued");

    await service.markCompleted(job.id, {
      workerId: "worker-2",
      responseStatus: 200,
      responseLatencyMs: 120,
    });
    attempts = await repo.listDeliveryAttempts(job.id);
    expect(attempts.length).toBe(3);
    expect(attempts[2]!.attemptNumber).toBe(3);
    expect(attempts[2]!.status).toBe("completed");
    expect(attempts[2]!.responseStatus).toBe(200);
  });

  test("computes attempt_number inside RPC so racing callers receive monotonically increasing values", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(testJobInput);

    // Concurrently trigger 10 execution writes
    const promises = Array.from({ length: 10 }, (_, i) =>
      service.markRunning(job.id, `worker-race-${i}`),
    );
    await Promise.all(promises);

    const attempts = await repo.listDeliveryAttempts(job.id);
    expect(attempts.length).toBe(10);

    const attemptNumbers = attempts.map((a) => a.attemptNumber);
    expect(attemptNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("respects rollback feature flag and falls back to legacy writes without inserting attempts", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const rpc = service.getRpc();
    const job = await service.ensureJobRecord(testJobInput);

    // Turn rollback flag ON for this account
    rpc.setRollbackFlagForAccount(job.accountId, true);
    expect(rpc.isRollbackActive(job.accountId)).toBe(true);

    const running = await service.markRunning(job.id, "worker-legacy");
    expect(running.status).toBe("running");
    expect(running.workerId).toBe("worker-legacy");

    // No delivery_attempts inserted in rollback mode
    const attempts = await repo.listDeliveryAttempts(job.id);
    expect(attempts.length).toBe(0);

    // Turn rollback flag OFF
    rpc.setRollbackFlagForAccount(job.accountId, false);
    expect(rpc.isRollbackActive(job.accountId)).toBe(false);

    await service.markCompleted(job.id, {
      workerId: "worker-phase2",
      responseStatus: 200,
    });
    const postAttempts = await repo.listDeliveryAttempts(job.id);
    expect(postAttempts.length).toBe(1);
    expect(postAttempts[0]!.attemptNumber).toBe(1);
    expect(postAttempts[0]!.status).toBe("completed");
  });
});
