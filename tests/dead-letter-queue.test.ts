import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY_BUDGET,
  countDeliveryTries,
  type RetryBudgetConfig,
} from "../src/application/dead-letter-queue";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobRecordService } from "../src/application/job-record-service";
import type { CreateJobInput, JobRecord } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const pilotAccount = "acct-pilot";
const briefId = "50ce0002-0000-4000-a001-000000000001";
const endpointUrl = "https://hooks.dana-fintech.com/tessera";

const baseInput: CreateJobInput = {
  accountId: pilotAccount,
  briefId,
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl,
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

interface SetupOptions {
  pilot?: boolean;
  rollback?: boolean;
  budgets?: RetryBudgetConfig;
}

function setup(options: SetupOptions = {}) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(jobs, attempts, {
    pilotAccountIds: new Set(options.pilot === false ? [] : [pilotAccount]),
    rollbackAccountIds: new Set(options.rollback ? [pilotAccount] : []),
  });
  const service = options.budgets
    ? new JobRecordService(jobs, rpc, options.budgets)
    : new JobRecordService(jobs, rpc);
  return { jobs, attempts, rpc, service };
}

/** One failed delivery try as the orchestrator writes it: running, queued, failed. */
async function failTry(service: JobRecordService, job: JobRecord, n: number): Promise<void> {
  await service.markRunning(job.id, "worker-us-east-04");
  await service.retry(job.id);
  await service.markFailed(job.id, `timeout ${n}`, {
    workerId: "worker-us-east-04",
    responseStatus: 503,
    errorBody: `endpoint returned 503 on try ${n}`,
  });
}

async function failTries(service: JobRecordService, job: JobRecord, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    await failTry(service, job, n);
  }
}

async function reload(jobs: InMemoryJobRepository, job: JobRecord): Promise<JobRecord> {
  const stored = await jobs.findById(job.id);
  if (!stored) {
    throw new Error(`job ${job.id} missing`);
  }
  return stored;
}

describe("dead letter queue", () => {
  test("counts delivery tries as running rows, not max attempt_number", async () => {
    const { jobs, rpc, service } = setup();
    const job = await service.ensureJobRecord(baseInput);
    await failTries(service, job, 3);

    const rows = await rpc.listAttempts(await reload(jobs, job));
    expect(rows.length).toBe(9);
    expect(countDeliveryTries(rows)).toBe(3);
  });

  test("a job is not DLQ-bound until the default budget of 8 tries is used", async () => {
    const { jobs, service } = setup();
    const job = await service.ensureJobRecord(baseInput);

    await failTries(service, job, DEFAULT_RETRY_BUDGET - 1);
    expect(await service.dlqSummary(await reload(jobs, job))).toBeNull();
    expect(await service.moveToDlqIfPastBudget(job.id)).toBeNull();

    await failTry(service, job, DEFAULT_RETRY_BUDGET);
    const summary = await service.dlqSummary(await reload(jobs, job));
    expect(summary).not.toBeNull();
    expect(summary?.retryBudget).toBe(DEFAULT_RETRY_BUDGET);
    expect(summary?.pastBudgetCount).toBe(DEFAULT_RETRY_BUDGET);
    expect(summary?.endpointUrl).toBe(endpointUrl);
  });

  test("honours a per-account retry budget", async () => {
    const { jobs, service } = setup({
      budgets: { defaultBudget: DEFAULT_RETRY_BUDGET, accountBudgets: new Map([[pilotAccount, 2]]) },
    });
    const job = await service.ensureJobRecord(baseInput);

    await failTries(service, job, 2);
    expect((await service.dlqSummary(await reload(jobs, job)))?.retryBudget).toBe(2);
  });

  test("returns the last three attempt bodies keyed only by (deliveryJobId, attemptNumber)", async () => {
    const { jobs, service } = setup({
      budgets: { defaultBudget: 4, accountBudgets: new Map() },
    });
    const job = await service.ensureJobRecord(baseInput);
    await failTries(service, job, 4);

    const stored = await reload(jobs, job);
    const summary = await service.dlqSummary(stored);
    expect(summary?.lastAttemptBodies).toEqual([
      {
        deliveryJobId: stored.deliveryJobId ?? "",
        attemptNumber: 6,
        responseStatus: 503,
        errorBody: "endpoint returned 503 on try 2",
      },
      {
        deliveryJobId: stored.deliveryJobId ?? "",
        attemptNumber: 9,
        responseStatus: 503,
        errorBody: "endpoint returned 503 on try 3",
      },
      {
        deliveryJobId: stored.deliveryJobId ?? "",
        attemptNumber: 12,
        responseStatus: 503,
        errorBody: "endpoint returned 503 on try 4",
      },
    ]);
  });

  test("a completed delivery after the budget is not DLQ-bound", async () => {
    const { jobs, service } = setup({ budgets: { defaultBudget: 2, accountBudgets: new Map() } });
    const job = await service.ensureJobRecord(baseInput);
    await failTries(service, job, 2);
    await service.markRunning(job.id, "worker-us-east-04");
    await service.markCompleted(job.id, { workerId: "worker-us-east-04", responseStatus: 200 });

    expect(await service.dlqSummary(await reload(jobs, job))).toBeNull();
  });

  test("drain_dlq processor ensures one drain_dlq job carrying the dispatch endpoint", async () => {
    const { jobs, service } = setup({ budgets: { defaultBudget: 2, accountBudgets: new Map() } });
    const job = await service.ensureJobRecord(baseInput);
    await failTries(service, job, 2);

    const drain = await service.moveToDlqIfPastBudget(job.id);
    const again = await service.moveToDlqIfPastBudget(job.id);

    expect(drain?.type).toBe("drain_dlq");
    expect(drain?.parentJobId).toBe(job.id);
    expect(drain?.metadata.endpointUrl).toBe(endpointUrl);
    expect(again?.id).toBe(drain?.id);
    expect(await jobs.findByBriefAndType(briefId, "drain_dlq")).toHaveLength(1);
  });

  test("listByBrief adds a dlq field and filters with status=dlq", async () => {
    const { service } = setup({ budgets: { defaultBudget: 2, accountBudgets: new Map() } });
    const job = await service.ensureJobRecord(baseInput);
    const other = await service.ensureJobRecord({ ...baseInput, briefId: "other-brief" });
    await failTries(service, job, 2);
    await failTries(service, other, 1);
    await service.moveToDlqIfPastBudget(job.id);

    const all = await service.listByBrief(briefId);
    expect(all.map((row) => row.type).sort()).toEqual(["dispatch_webhook", "drain_dlq"]);
    expect(all.find((row) => row.type === "drain_dlq")?.dlq).toBeNull();

    const dlq = await service.listByBrief(briefId, { status: "dlq" });
    expect(dlq.map((row) => row.id)).toEqual([job.id]);
    expect(dlq[0]?.dlq?.pastBudgetCount).toBe(2);

    expect(await service.listByBrief("other-brief", { status: "dlq" })).toEqual([]);
  });

  test("legacy and rolled-back accounts never report a job as DLQ-bound", async () => {
    for (const options of [{ pilot: false }, { rollback: true }]) {
      const { jobs, service } = setup({ ...options, budgets: { defaultBudget: 1, accountBudgets: new Map() } });
      const job = await service.ensureJobRecord(baseInput);
      await failTries(service, job, 2);

      expect(await service.dlqSummary(await reload(jobs, job))).toBeNull();
      expect(await service.moveToDlqIfPastBudget(job.id)).toBeNull();
    }
  });

  test("the orchestrator moves a failed delivery past the budget to the DLQ", async () => {
    const { jobs, service } = setup({ budgets: { defaultBudget: 2, accountBudgets: new Map() } });
    const orchestrator = new DeliveryOrchestrator(service);
    const request = {
      accountId: pilotAccount,
      briefId,
      customerId: baseInput.metadata.customerId,
      subscriptionId: baseInput.metadata.subscriptionId,
      endpointUrl,
      eventType: baseInput.metadata.eventType,
      payloadHash: baseInput.metadata.payloadHash,
      workerId: "worker-us-east-04",
      simulateFailure: true,
    };

    const first = await orchestrator.deliver(request);
    expect(first.status).toBe("failed");
    expect(await jobs.findByBriefAndType(briefId, "drain_dlq")).toHaveLength(0);

    await orchestrator.deliver(request);
    const drains = await jobs.findByBriefAndType(briefId, "drain_dlq");
    expect(drains).toHaveLength(1);
    expect(drains[0]?.parentJobId).toBe(first.id);
  });
});
