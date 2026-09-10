import { describe, expect, test } from "bun:test";
import { InMemoryAccountRetryBudget } from "../src/application/account-retry-budget";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const baseRequest = {
  accountId: "acct-1",
  briefId: "brief-dlq-regression",
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-us-east-04",
} as const;

function createStack(budget = 8) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
  const retryBudgets = new InMemoryAccountRetryBudget();
  retryBudgets.setRetryBudget("acct-1", budget);
  const attemptRpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);
  const jobRecords = new JobRecordService(jobs, attemptRpc, rollbackFlags, retryBudgets);
  const orchestrator = new DeliveryOrchestrator(jobRecords);
  const drainDlq = new DrainDlqProcessor(jobRecords, attemptRpc, retryBudgets, rollbackFlags);

  return { jobs, attempts, rollbackFlags, jobRecords, orchestrator, drainDlq, attemptRpc };
}

describe("DLQ classification regressions", () => {
  test("four successful deliveries stay out of DLQ with the default budget", async () => {
    const { orchestrator, jobRecords } = createStack();

    for (let i = 0; i < 4; i += 1) {
      await orchestrator.deliver({
        ...baseRequest,
        workerId: `worker-${i}`,
        simulateFailure: false,
      });
    }

    const job = (await jobRecords.listByBrief(baseRequest.briefId))[0];
    expect(job).toBeDefined();
    expect(await jobRecords.displayStatus(job!)).toBe("completed");
    expect(await jobRecords.isInDlq(job!)).toBe(false);
  });

  test("failed deliveries stay below the default budget until the eighth attempt", async () => {
    const { orchestrator, jobRecords } = createStack();

    for (let i = 0; i < 7; i += 1) {
      await orchestrator.deliver({
        ...baseRequest,
        workerId: `worker-${i}`,
        simulateFailure: true,
      });
    }

    const job = (await jobRecords.listByBrief(baseRequest.briefId))[0];
    expect(job?.retryCount).toBe(7);
    expect(await jobRecords.displayStatus(job!)).toBe("failed");
    expect(await jobRecords.isInDlq(job!)).toBe(false);

    await orchestrator.deliver({
      ...baseRequest,
      workerId: "worker-8",
      simulateFailure: true,
    });

    expect(await jobRecords.displayStatus(job!)).toBe("dlq");
    expect(await jobRecords.isInDlq(job!)).toBe(true);
  });

  test("successful delivery after failures is not classified as DLQ", async () => {
    const { orchestrator, jobRecords } = createStack(2);

    for (let i = 0; i < 2; i += 1) {
      await orchestrator.deliver({
        ...baseRequest,
        workerId: `worker-fail-${i}`,
        simulateFailure: true,
      });
    }

    await orchestrator.deliver({
      ...baseRequest,
      workerId: "worker-success",
      simulateFailure: false,
    });

    const job = (await jobRecords.listByBrief(baseRequest.briefId))[0];
    expect(await jobRecords.displayStatus(job!)).toBe("completed");
    expect(await jobRecords.isInDlq(job!)).toBe(false);
  });

  test("account-specific budgets gate DLQ independently", async () => {
    const { orchestrator, jobRecords } = createStack(2);

    for (let i = 0; i < 2; i += 1) {
      await orchestrator.deliver({
        ...baseRequest,
        workerId: `worker-${i}`,
        simulateFailure: true,
      });
    }

    const job = (await jobRecords.listByBrief(baseRequest.briefId))[0];
    expect(await jobRecords.displayStatus(job!)).toBe("dlq");
    expect(await jobRecords.isInDlq(job!)).toBe(true);
  });

  test("repeated drains are idempotent and keep diagnostic bodies", async () => {
    const { jobRecords, drainDlq, attemptRpc } = createStack(2);
    const job = await jobRecords.ensureWebhookDispatchJob("acct-1", baseRequest.briefId, {
      customerId: baseRequest.customerId,
      subscriptionId: baseRequest.subscriptionId,
      endpointUrl: baseRequest.endpointUrl,
      eventType: baseRequest.eventType,
      payloadHash: baseRequest.payloadHash,
    });

    await jobRecords.markRunning(job.id, "worker-1");
    await jobRecords.markFailed(job.id, "first", { errorBody: "body-1" });
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-2");
    await jobRecords.markFailed(job.id, "second", { errorBody: "body-2" });

    const failedBeforeDrain = await attemptRpc.countFailedExecutions(job.id);
    await drainDlq.drain({ accountId: "acct-1", briefId: baseRequest.briefId });
    await drainDlq.drain({ accountId: "acct-1", briefId: baseRequest.briefId });
    const failedAfterSecondDrain = await attemptRpc.countFailedExecutions(job.id);

    const summary = await drainDlq.buildDlqSummary(baseRequest.briefId, "acct-1");
    expect(summary.endpoints[0]?.lastAttemptBodies[0]).toBe("body-2");
    expect(summary.endpoints[0]?.lastAttemptBodies.some((body) => body.startsWith("DLQ:"))).toBe(
      false,
    );

    const afterSecondDrain = await jobRecords.listByBrief(baseRequest.briefId);
    const dispatchJob = afterSecondDrain.find((row) => row.type === "dispatch_webhook");
    expect(dispatchJob?.errorMessage).toContain("dead letter queue");
    expect(failedBeforeDrain).toBe(2);
    expect(failedAfterSecondDrain).toBe(2);
  });

  test("rollback keeps DLQ filter and summary aligned with legacy state", async () => {
    const { jobRecords, drainDlq, rollbackFlags } = createStack(2);
    rollbackFlags.enable("acct-1");

    const job = await jobRecords.ensureWebhookDispatchJob("acct-1", baseRequest.briefId, {
      customerId: baseRequest.customerId,
      subscriptionId: baseRequest.subscriptionId,
      endpointUrl: baseRequest.endpointUrl,
      eventType: baseRequest.eventType,
      payloadHash: baseRequest.payloadHash,
    });

    await jobRecords.markRunning(job.id, "worker-1");
    await jobRecords.markFailed(job.id, "first");
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-2");
    await jobRecords.markFailed(job.id, "second");
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-3");
    await jobRecords.markFailed(job.id, "third");

    expect(await jobRecords.displayStatus(job)).toBe("dlq");
    expect(await jobRecords.isInDlq(job)).toBe(true);

    const summary = await drainDlq.buildDlqSummary(baseRequest.briefId, "acct-1");
    expect(summary.pastBudgetCount).toBe(1);
    expect(summary.endpoints[0]?.lastAttemptBodies).toHaveLength(0);
  });
});
