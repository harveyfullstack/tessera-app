import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobRecordService } from "../src/application/job-record-service";
import { DEFAULT_RETRY_BUDGET } from "../src/domain/account-retry-budget";
import type { CreateJobInput, JobMetadata } from "../src/domain/job";
import { InMemoryAccountRetryBudget } from "../src/infrastructure/in-memory-account-retry-budget";
import { InMemoryRollbackFeatureFlag } from "../src/infrastructure/in-memory-rollback-feature-flag";
import { InMemoryDeliveryJobRepository } from "../src/infrastructure/repositories/in-memory-delivery-job-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  type: "dispatch_webhook",
  metadata,
};

const baseRequest = {
  accountId: "acct-1",
  briefId: baseInput.briefId,
  ...metadata,
  workerId: "worker-us-east-04",
} as const;

function createStack(budget?: number, rollbackAccounts: readonly string[] = []) {
  const jobs = new InMemoryJobRepository();
  const deliveryJobs = new InMemoryDeliveryJobRepository();
  const rollbackFlag = new InMemoryRollbackFeatureFlag(rollbackAccounts);
  const retryBudgets = new InMemoryAccountRetryBudget();
  if (budget !== undefined) {
    retryBudgets.setRetryBudget("acct-1", budget);
  }
  const rpc = new DeliveryAttemptRpc(jobs, deliveryJobs, rollbackFlag);
  const jobRecords = new JobRecordService(
    jobs,
    rpc,
    deliveryJobs,
    rollbackFlag,
    retryBudgets,
  );
  return {
    jobs,
    deliveryJobs,
    retryBudgets,
    jobRecords,
    orchestrator: new DeliveryOrchestrator(jobRecords),
  };
}

async function failTimes(service: JobRecordService, jobId: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await service.markRunning(jobId, `worker-${i}`);
    await service.markFailed(jobId, `endpoint timeout ${i + 1}`, {
      workerId: `worker-${i}`,
      responseStatus: 503,
      errorBody: `body-${i + 1}`,
    });
  }
}

describe("retry budget", () => {
  test("defaults to 8 attempts and can be overridden per account", () => {
    const budgets = new InMemoryAccountRetryBudget();

    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    expect(budgets.getRetryBudget("acct-unknown")).toBe(8);

    budgets.setRetryBudget("acct-1", 2);
    expect(budgets.getRetryBudget("acct-1")).toBe(2);
    expect(budgets.getRetryBudget("acct-2")).toBe(8);
  });
});

describe("DLQ-bound endpoints", () => {
  test("a job is not DLQ-bound below the account retry budget", async () => {
    const { jobRecords } = createStack();
    const job = await jobRecords.ensureJobRecord(baseInput);

    await failTimes(jobRecords, job.id, DEFAULT_RETRY_BUDGET - 1);

    expect(await jobRecords.isInDlq(job)).toBe(false);
    expect(await jobRecords.displayStatus(job)).toBe("failed");
  });

  test("a job is DLQ-bound once failed attempts reach the default budget of 8", async () => {
    const { jobRecords } = createStack();
    const job = await jobRecords.ensureJobRecord(baseInput);

    await failTimes(jobRecords, job.id, DEFAULT_RETRY_BUDGET);

    expect(await jobRecords.isInDlq(job)).toBe(true);
    expect(await jobRecords.displayStatus(job)).toBe("dlq");
  });

  test("an account-specific budget gates DLQ independently", async () => {
    const { jobRecords } = createStack(2);
    const job = await jobRecords.ensureJobRecord(baseInput);

    await failTimes(jobRecords, job.id, 2);

    expect(await jobRecords.isInDlq(job)).toBe(true);
    expect(await jobRecords.displayStatus(job)).toBe("dlq");
  });

  test("successful deliveries never land in DLQ even after prior failures", async () => {
    const { orchestrator, jobRecords } = createStack(2);

    await orchestrator.deliver({ ...baseRequest, simulateFailure: true });
    await orchestrator.deliver({
      ...baseRequest,
      workerId: "worker-us-east-07",
      simulateFailure: true,
    });
    await orchestrator.deliver({
      ...baseRequest,
      workerId: "worker-success",
      simulateFailure: false,
    });

    const job = (await jobRecords.listByBrief(baseInput.briefId)).find(
      (row) => row.type === "dispatch_webhook",
    );
    expect(job).toBeDefined();
    expect(await jobRecords.displayStatus(job!)).toBe("completed");
    expect(await jobRecords.isInDlq(job!)).toBe(false);
  });

  test("creates a drain_dlq job when an endpoint crosses the retry budget", async () => {
    const { jobRecords } = createStack(2);
    const job = await jobRecords.ensureJobRecord(baseInput);

    await failTimes(jobRecords, job.id, 2);

    const drain = await jobRecords.listByBrief(baseInput.briefId);
    expect(drain.some((row) => row.type === "drain_dlq")).toBe(true);
    expect(drain.find((row) => row.type === "drain_dlq")?.id).toBe(
      (await jobRecords.ensureDrainDlqJob(baseInput.accountId, baseInput.briefId)).id,
    );
  });

  test("rollback classifies DLQ from legacy retryCount", async () => {
    const { jobRecords } = createStack(2, [baseInput.accountId]);
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markFailed(job.id, "first");
    await jobRecords.retry(job.id);
    expect(await jobRecords.isInDlq(job)).toBe(false);

    await jobRecords.markFailed(job.id, "second");
    const exhausted = await jobRecords.retry(job.id);

    expect(exhausted.retryCount).toBe(2);
    expect(await jobRecords.isInDlq(job)).toBe(true);
    expect(await jobRecords.displayStatus(job)).toBe("dlq");
  });
});

describe("GET /briefs/:briefId/jobs DLQ surface", () => {
  test("includes a dlq field with past-budget count and the last three attempt bodies", async () => {
    const { jobRecords } = createStack(2);
    const job = await jobRecords.ensureJobRecord(baseInput);

    await failTimes(jobRecords, job.id, 4);

    const payload = await jobRecords.listBriefJobs(baseInput.briefId);

    expect(payload.dlq).toHaveLength(1);
    expect(payload.dlq[0]).toEqual({
      endpointUrl: metadata.endpointUrl,
      pastBudgetCount: 1,
      lastAttempts: [
        { attemptNumber: 8, status: "failed", errorBody: "endpoint timeout 4", responseStatus: 503 },
        { attemptNumber: 6, status: "failed", errorBody: "endpoint timeout 3", responseStatus: 503 },
        { attemptNumber: 4, status: "failed", errorBody: "endpoint timeout 2", responseStatus: 503 },
      ],
    });
    expect(payload.jobs.find((row) => row.type === "dispatch_webhook")?.displayStatus).toBe("dlq");
  });

  test("status=dlq filters to DLQ-bound jobs and still returns the dlq field", async () => {
    const { jobRecords } = createStack(2);
    const exhausted = await jobRecords.ensureJobRecord(baseInput);
    await failTimes(jobRecords, exhausted.id, 2);

    const allOnBrief = await jobRecords.listBriefJobs(baseInput.briefId);
    const filtered = await jobRecords.listBriefJobs(baseInput.briefId, "dlq");

    expect(allOnBrief.jobs.some((row) => row.type === "drain_dlq")).toBe(true);
    expect(filtered.jobs.every((row) => row.displayStatus === "dlq")).toBe(true);
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0]?.id).toBe(exhausted.id);
    expect(filtered.dlq).toHaveLength(1);
    expect(filtered.dlq[0]?.pastBudgetCount).toBe(1);
    expect(filtered.dlq[0]?.lastAttempts).toHaveLength(2);
  });

  test("returns an empty dlq field when no endpoint is past budget", async () => {
    const { jobRecords } = createStack();
    await jobRecords.ensureJobRecord(baseInput);

    const payload = await jobRecords.listBriefJobs(baseInput.briefId);

    expect(payload.dlq).toEqual([]);
    expect(payload.jobs[0]?.displayStatus).toBe("queued");
  });
});
