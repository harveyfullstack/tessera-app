import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { verifyAttemptCountParity } from "../src/application/delivery-attempt-parity";
import { DuplicateAttemptNumberError } from "../src/domain/delivery-attempt-repository";
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

  test("does not rewind the sequence when inserting a lower historical number", async () => {
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

  test("rejects duplicate attempt numbers for the same job", async () => {
    const attempts = new InMemoryDeliveryAttemptRepository();

    await attempts.insert({
      deliveryJobId: "job-1",
      attemptNumber: 1,
      status: "failed",
    });

    await expect(
      attempts.insert({
        deliveryJobId: "job-1",
        attemptNumber: 1,
        status: "failed",
      }),
    ).rejects.toBeInstanceOf(DuplicateAttemptNumberError);
  });

  test("parity check requires exact terminal attempt counts", async () => {
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

    const parity = await verifyAttemptCountParity([job], rpc, (jobId) => jobs.findById(jobId));
    expect(parity.allMatch).toBe(true);
    expect(parity.results[0]?.attemptRowCount).toBe(1);
    expect(parity.results[0]?.legacyAttemptCount).toBe(1);
  });

  test("parity check rejects over-counted attempt rows", async () => {
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
