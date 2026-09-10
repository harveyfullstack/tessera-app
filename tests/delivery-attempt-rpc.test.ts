import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { verifyAttemptCountParity } from "../src/application/delivery-attempt-parity";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "cus",
  subscriptionId: "sub",
  endpointUrl: "https://example.com/hook",
  eventType: "test",
  payloadHash: "sha256:test",
};

function createRpc() {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
  const rpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);
  return { jobs, attempts, rollbackFlags, rpc };
}

describe("DeliveryAttemptRpc", () => {
  test("assigns monotonically increasing attempt numbers under concurrent writes", async () => {
    const { jobs, attempts, rpc } = createRpc();
    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await Promise.all([
      rpc.markRunning(job.id, "worker-a"),
      rpc.markRunning(job.id, "worker-b"),
    ]);

    const history = await attempts.listByJobId(job.id);
    const numbers = history.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
  });

  test("does not rewind the sequence when inserting a lower historical number", async () => {
    const { jobs, attempts, rpc } = createRpc();
    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 5,
      status: "failed",
      errorBody: "historical",
    });

    await rpc.markRunning(job.id, "worker-1");
    const latest = await attempts.listByJobId(job.id);
    expect(latest[0]?.attemptNumber).toBe(6);
  });

  test("checks the rollback feature flag only at the RPC boundary", async () => {
    const { jobs, attempts, rollbackFlags, rpc } = createRpc();
    rollbackFlags.enable("acct-1");
    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await rpc.markRunning(job.id, "worker-1");
    await rpc.retry(job.id);
    await rpc.markFailed(job.id, "rolled back");

    expect(await attempts.countByJobId(job.id)).toBe(0);
    const updated = await jobs.findById(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.retryCount).toBe(1);
  });

  test("parity check requires exact terminal attempt counts", async () => {
    const { jobs, rpc } = createRpc();
    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await rpc.markRunning(job.id, "worker-1");
    await rpc.markCompleted(job.id, { workerId: "worker-1", responseStatus: 200 });

    const parity = await verifyAttemptCountParity([job], rpc, (jobId) => jobs.findById(jobId));
    expect(parity.allMatch).toBe(true);
    expect(parity.results[0]?.attemptRowCount).toBe(1);
    expect(parity.results[0]?.legacyAttemptCount).toBe(1);
  });

  test("parity check rejects over-counted attempt rows", async () => {
    const { jobs, attempts, rpc } = createRpc();
    const job = await jobs.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "completed",
    });
    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 2,
      status: "completed",
    });

    const parity = await verifyAttemptCountParity([job], rpc);
    expect(parity.allMatch).toBe(false);
  });
});
