import { describe, expect, test } from "bun:test";
import { DeadLetterQueueInspector } from "../src/application/dead-letter-queue-inspector";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { DEFAULT_RETRY_BUDGET, RetryBudgetPolicy } from "../src/application/retry-budget-policy";
import type { DeliveryAttempt } from "../src/domain/delivery-attempt";
import type { JobRecord } from "../src/domain/job";
import { StaticDeliveryRollbackFlag } from "../src/infrastructure/flags/static-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const accountId = "acct-1";
const briefId = "50ce0002-0000-4000-a001-000000000001";

const deliverRequest = {
  accountId,
  briefId,
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-us-east-04",
} as const;

function setup(budgets: RetryBudgetPolicy, closedRollbackAccounts: string[] = []) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(
    jobs,
    attempts,
    new StaticDeliveryRollbackFlag(closedRollbackAccounts),
  );
  const jobRecords = new JobRecordService(jobs, rpc);
  const inspector = new DeadLetterQueueInspector(attempts, budgets);
  return {
    jobRecords,
    inspector,
    orchestrator: new DeliveryOrchestrator(jobRecords),
    processor: new DrainDlqProcessor(jobRecords, inspector),
  };
}

async function failRuns(orchestrator: DeliveryOrchestrator, runs: number): Promise<JobRecord> {
  let job: JobRecord | undefined;
  for (let run = 0; run < runs; run += 1) {
    job = await orchestrator.deliver({ ...deliverRequest, simulateFailure: true });
  }
  if (!job) {
    throw new Error("failRuns needs at least one run");
  }
  return job;
}

function legacyJob(overrides: Partial<JobRecord>): JobRecord {
  const now = new Date("2026-01-01T10:00:00Z");
  return {
    id: "legacy-job",
    accountId,
    briefId,
    type: "dispatch_webhook",
    metadata: { ...deliverRequest },
    status: "failed",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("RetryBudgetPolicy", () => {
  test("defaults to 8 runs and honors per-account overrides", () => {
    const policy = new RetryBudgetPolicy(new Map([["acct-override", 3]]));

    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    expect(policy.budgetFor("acct-other")).toBe(8);
    expect(policy.budgetFor("acct-override")).toBe(3);
  });

  test("rejects budgets that are not positive integers", () => {
    expect(() => new RetryBudgetPolicy(new Map([["acct", 0]]))).toThrow(RangeError);
    expect(() => new RetryBudgetPolicy(new Map(), 2.5)).toThrow(RangeError);
  });
});

describe("DeadLetterQueueInspector", () => {
  test("counts runs by 'running' rows, not by MAX(attempt_number)", async () => {
    const { orchestrator, inspector } = setup(new RetryBudgetPolicy(new Map([[accountId, 3]])));

    // Each failed run writes running, queued and failed rows: 3 rows per run.
    const job = await failRuns(orchestrator, 2);
    expect(await inspector.evaluate(job)).toBeNull();

    const dlq = await inspector.evaluate(await failRuns(orchestrator, 1));
    expect(dlq?.runs).toBe(3);
    expect(dlq?.retryBudget).toBe(3);
    expect(dlq?.endpointUrl).toBe(deliverRequest.endpointUrl);
  });

  test("returns the last three terminal attempt bodies, newest first", async () => {
    const { orchestrator, inspector } = setup(new RetryBudgetPolicy(new Map([[accountId, 4]])));

    const dlq = await inspector.evaluate(await failRuns(orchestrator, 4));

    expect(dlq?.lastAttemptBodies).toHaveLength(3);
    const numbers = dlq?.lastAttemptBodies.map((body) => body.attemptNumber) ?? [];
    expect(numbers).toEqual([...numbers].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(dlq?.lastAttemptBodies.every((body) => body.status === "failed")).toBe(true);
    expect(dlq?.lastAttemptBodies[0]?.errorBody).toBe("endpoint returned 503 after 30s timeout");
    expect(dlq?.lastAttemptBodies[0]?.responseStatus).toBe(503);
  });

  test("does not flag an endpoint whose latest run completed", async () => {
    const { orchestrator, inspector } = setup(new RetryBudgetPolicy(new Map([[accountId, 2]])));

    await failRuns(orchestrator, 2);
    const job = await orchestrator.deliver({ ...deliverRequest, simulateFailure: false });

    expect(await inspector.evaluate(job)).toBeNull();
  });

  test("keeps NULL error bodies of backfilled attempts", async () => {
    const job = legacyJob({ id: "backfilled-job" });
    const backfilled = (attemptNumber: number, status: DeliveryAttempt["status"]): DeliveryAttempt => ({
      id: `attempt-${attemptNumber}`,
      deliveryJobId: job.id,
      attemptNumber,
      status,
      backfilled: true,
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    const reader = {
      listByJob: async () => [
        backfilled(1, "running"),
        backfilled(2, "failed"),
        backfilled(3, "running"),
        backfilled(4, "failed"),
      ],
    };
    const inspector = new DeadLetterQueueInspector(
      reader,
      new RetryBudgetPolicy(new Map([[accountId, 2]])),
    );

    const dlq = await inspector.evaluate(job);

    expect(dlq?.runs).toBe(2);
    expect(dlq?.lastAttemptBodies).toEqual([
      { attemptNumber: 4, status: "failed", responseStatus: null, errorBody: null, backfilled: true },
      { attemptNumber: 2, status: "failed", responseStatus: null, errorBody: null, backfilled: true },
    ]);
  });

  test("falls back to legacy retry_count when a job has no attempt rows", async () => {
    const inspector = new DeadLetterQueueInspector(
      { listByJob: async () => [] },
      new RetryBudgetPolicy(),
    );
    const startedAt = new Date("2026-01-01T10:00:00Z");

    const underBudget = legacyJob({ retryCount: 7, startedAt });
    const pastBudget = legacyJob({ retryCount: 8, startedAt, errorMessage: "timeout" });
    const neverStarted = legacyJob({ retryCount: 8, status: "queued" });

    expect(await inspector.evaluate(underBudget)).toBeNull();
    expect(await inspector.evaluate(neverStarted)).toBeNull();
    expect(await inspector.evaluate(pastBudget)).toMatchObject({
      runs: 8,
      lastAttemptBodies: [
        { attemptNumber: null, status: "failed", errorBody: "timeout", backfilled: false },
      ],
    });
  });

  test("ignores drain_dlq jobs", async () => {
    const inspector = new DeadLetterQueueInspector(
      { listByJob: async () => [] },
      new RetryBudgetPolicy(new Map([[accountId, 1]])),
    );
    const job = legacyJob({ type: "drain_dlq", retryCount: 5, startedAt: new Date() });

    expect(await inspector.evaluate(job)).toBeNull();
  });
});

describe("DrainDlqProcessor", () => {
  test("moves a past-budget endpoint to the DLQ once", async () => {
    const { orchestrator, processor, jobRecords } = setup(
      new RetryBudgetPolicy(new Map([[accountId, 2]])),
    );
    const dispatch = await failRuns(orchestrator, 2);
    const request = { accountId, briefId, workerId: "worker-dlq-01" };

    const moves = await processor.process(request);

    expect(moves).toHaveLength(1);
    expect(moves[0]?.endpoint.jobId).toBe(dispatch.id);
    expect(moves[0]?.drainJob.type).toBe("drain_dlq");
    expect(moves[0]?.drainJob.parentJobId).toBe(dispatch.id);
    expect(await processor.process(request)).toEqual([]);

    const drainJobs = (await jobRecords.listByBrief(briefId)).filter((job) => job.type === "drain_dlq");
    expect(drainJobs).toHaveLength(1);
  });

  test("leaves endpoints within budget alone", async () => {
    const { orchestrator, processor, jobRecords } = setup(new RetryBudgetPolicy());
    await failRuns(orchestrator, 2);

    expect(await processor.process({ accountId, briefId, workerId: "worker-dlq-01" })).toEqual([]);
    const drainJobs = (await jobRecords.listByBrief(briefId)).filter((job) => job.type === "drain_dlq");
    expect(drainJobs).toHaveLength(0);
  });

  test("is idempotent when the rollback window is closed and legacy columns are not written", async () => {
    const { orchestrator, processor } = setup(
      new RetryBudgetPolicy(new Map([[accountId, 1]])),
      [accountId],
    );
    await failRuns(orchestrator, 1);
    const request = { accountId, briefId, workerId: "worker-dlq-01" };

    expect(await processor.process(request)).toHaveLength(1);
    expect(await processor.process(request)).toEqual([]);
  });
});
