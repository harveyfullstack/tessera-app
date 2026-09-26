import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { createRetryBudgetResolver } from "../src/application/retry-budget";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook",
  metadata: {
    customerId: "customer-1",
    subscriptionId: "subscription-1",
    endpointUrl: "https://hooks.example.com/primary",
    eventType: "anomaly.detected",
    payloadHash: "sha256:payload",
  },
};

describe("DrainDlqProcessor", () => {
  test("moves only endpoints at their account budget into the DLQ", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rpc = new DeliveryAttemptRpc(jobs, attempts);
    const processor = new DrainDlqProcessor(
      jobs,
      attempts,
      rpc,
      createRetryBudgetResolver("acct-1=4"),
    );
    const exhausted = await jobs.create(baseInput);
    const belowBudget = await jobs.create({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        endpointUrl: "https://hooks.example.com/secondary",
      },
    });

    for (let attemptNumber = 1; attemptNumber <= 4; attemptNumber += 1) {
      await attempts.insert({
        deliveryJobId: exhausted.id,
        attemptNumber,
        status: "failed",
        errorBody: `failure-${attemptNumber}`,
      });
    }
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      await attempts.insert({
        deliveryJobId: belowBudget.id,
        attemptNumber,
        status: "failed",
        errorBody: `secondary-failure-${attemptNumber}`,
      });
    }

    const result = await processor.process({
      type: "drain_dlq",
      briefId: baseInput.briefId,
    });

    expect(result.dlq.pastBudgetCount).toBe(1);
    expect(result.jobs.map((job) => job.status)).toEqual(["dlq"]);
    expect(result.dlq.endpoints).toEqual([
      {
        accountId: baseInput.accountId,
        deliveryJobId: exhausted.id,
        endpointUrl: baseInput.metadata.endpointUrl,
        attemptBodies: ["failure-2", "failure-3", "failure-4"],
      },
    ]);
  });

  test("uses the default retry budget for accounts without an override", () => {
    const retryBudget = createRetryBudgetResolver("acct-1=3");

    expect(retryBudget("acct-1")).toBe(3);
    expect(retryBudget("acct-2")).toBe(8);
  });

  test("does not dead-letter an endpoint with no attempts at a zero budget", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rpc = new DeliveryAttemptRpc(jobs, attempts);
    const processor = new DrainDlqProcessor(
      jobs,
      attempts,
      rpc,
      createRetryBudgetResolver("acct-1=0"),
    );
    const job = await jobs.create(baseInput);

    const beforeAttempt = await processor.process({
      type: "drain_dlq",
      briefId: baseInput.briefId,
    });
    expect(beforeAttempt.dlq.pastBudgetCount).toBe(0);

    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "failed",
      errorBody: "first failure",
    });
    const afterAttempt = await processor.process({
      type: "drain_dlq",
      briefId: baseInput.briefId,
    });

    expect(afterAttempt.dlq.pastBudgetCount).toBe(1);
  });

  test("uses legacy retry state for accounts in rollback mode", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rpc = new DeliveryAttemptRpc(jobs, attempts, () => true);
    const processor = new DrainDlqProcessor(
      jobs,
      attempts,
      rpc,
      createRetryBudgetResolver("acct-1=2"),
    );
    const job = await jobs.create(baseInput);

    await jobs.incrementRetry(job.id);
    await jobs.incrementRetry(job.id);
    await jobs.updateExecution(job.id, {
      status: "failed",
      errorMessage: "legacy failure body",
    });

    const result = await processor.process({
      type: "drain_dlq",
      briefId: baseInput.briefId,
    });

    expect(result.dlq.pastBudgetCount).toBe(1);
    expect(result.dlq.endpoints[0]?.attemptBodies).toEqual([
      "legacy failure body",
    ]);
    expect(await attempts.listByJobId(job.id)).toEqual([]);
  });
});
