import { describe, expect, test } from "bun:test";
import { InMemoryAccountRetryBudget } from "../src/application/account-retry-budget";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const baseInput = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  type: "dispatch_webhook" as const,
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

function createProcessor(budget = 8) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
  const retryBudgets = new InMemoryAccountRetryBudget();
  retryBudgets.setRetryBudget("acct-1", budget);
  const attemptRpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);
  const jobRecords = new JobRecordService(jobs, attemptRpc, rollbackFlags, retryBudgets);
  const processor = new DrainDlqProcessor(jobRecords, attemptRpc, retryBudgets, rollbackFlags);

  return { processor, jobRecords, attempts };
}

describe("DrainDlqProcessor", () => {
  test("marks jobs past the retry budget as failed during drain", async () => {
    const { processor, jobRecords } = createProcessor(3);
    const job = await jobRecords.ensureJobRecord(baseInput);

    for (let i = 0; i < 3; i += 1) {
      await jobRecords.markRunning(job.id, `worker-${i}`);
      await jobRecords.markFailed(job.id, `failure ${i}`, { errorBody: `body-${i}` });
      await jobRecords.retry(job.id);
    }

    const drained = await processor.drain({ accountId: "acct-1", briefId: baseInput.briefId });
    expect(drained.type).toBe("drain_dlq");
    expect(drained.status).toBe("completed");

    const updated = (await jobRecords.listByBrief(baseInput.briefId)).find((row) => row.id === job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toContain("dead letter queue");
    expect(await jobRecords.displayStatus(job)).toBe("dlq");
  });

  test("builds dlq summaries with last three attempt bodies per endpoint", async () => {
    const { processor, jobRecords } = createProcessor(2);
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-1");
    await jobRecords.markFailed(job.id, "first", { errorBody: "body-1" });
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-2");
    await jobRecords.markFailed(job.id, "second", { errorBody: "body-2" });

    const summary = await processor.buildDlqSummary(baseInput.briefId, "acct-1");
    expect(summary.pastBudgetCount).toBe(1);
    expect(summary.endpoints).toHaveLength(1);
    expect(summary.endpoints[0]?.lastAttemptBodies[0]).toBe("body-2");
    expect(summary.endpoints[0]?.lastAttempts[0]?.errorBody).toBe("body-2");
  });
});
