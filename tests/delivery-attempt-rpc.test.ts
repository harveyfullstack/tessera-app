import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { verifyAttemptCountParity } from "../src/application/delivery-attempt-parity";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

describe("DeliveryAttemptRpc", () => {
  test("assigns monotonically increasing attempt numbers under concurrent writes", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
    const rpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);

    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata: {
        customerId: "cus",
        subscriptionId: "sub",
        endpointUrl: "https://example.com/hook",
        eventType: "test",
        payloadHash: "sha256:test",
      },
    });

    await Promise.all([
      rpc.markRunning(job.id, "worker-a"),
      rpc.markRunning(job.id, "worker-b"),
    ]);

    const history = await attempts.listByJobId(job.id);
    const numbers = history.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
  });

  test("parity check compares legacy counts to attempt rows", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
    const rpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);

    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata: {
        customerId: "cus",
        subscriptionId: "sub",
        endpointUrl: "https://example.com/hook",
        eventType: "test",
        payloadHash: "sha256:test",
      },
    });

    await rpc.markRunning(job.id, "worker-1");
    await rpc.markCompleted(job.id, { workerId: "worker-1", responseStatus: 200 });

    const parity = await verifyAttemptCountParity([job], rpc);
    expect(parity.allMatch).toBe(true);
  });
});
