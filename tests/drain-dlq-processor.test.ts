import { describe, expect, test } from "bun:test";
import { DlqInspector } from "../src/application/dlq-inspector";
import { DrainDlqProcessor, InvalidDrainJobError } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { DEFAULT_RETRY_BUDGET, RetryBudgetPolicy } from "../src/application/retry-budget-policy";
import type { DeliveryAttemptStatus } from "../src/domain/delivery-attempt";
import type {
  DeliveryAttemptReader,
  DeliveryAttemptSnapshot,
} from "../src/domain/delivery-attempt-reader";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeadLetterQueue } from "../src/infrastructure/repositories/in-memory-dead-letter-queue";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const accountId = "acct-1";
const briefId = "50ce0002-0000-4000-a001-000000000001";

const dispatchInput: CreateJobInput = {
  accountId,
  briefId,
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

const drainInput: CreateJobInput = { ...dispatchInput, type: "drain_dlq" };

class FakeAttemptReader implements DeliveryAttemptReader {
  private readonly attempts = new Map<string, DeliveryAttemptSnapshot[]>();

  record(deliveryJobId: string, statuses: readonly DeliveryAttemptStatus[]): void {
    const rows = statuses.map((status, index) => ({
      deliveryJobId,
      attemptNumber: index + 1,
      status,
      responseStatus: status === "failed" ? 503 : 200,
      errorBody: status === "failed" ? `attempt ${index + 1}: endpoint returned 503` : undefined,
      startedAt: new Date(),
    }));
    this.attempts.set(deliveryJobId, rows);
  }

  async countByDeliveryJob(deliveryJobId: string): Promise<number> {
    return this.attempts.get(deliveryJobId)?.length ?? 0;
  }

  async listLatestByDeliveryJob(deliveryJobId: string, limit: number): Promise<DeliveryAttemptSnapshot[]> {
    const rows = this.attempts.get(deliveryJobId) ?? [];
    return [...rows].sort((a, b) => b.attemptNumber - a.attemptNumber).slice(0, limit);
  }
}

function failures(count: number): DeliveryAttemptStatus[] {
  return Array.from({ length: count }, () => "failed" as const);
}

function setup(budgets = new RetryBudgetPolicy()) {
  const service = new JobRecordService(new InMemoryJobRepository());
  const attempts = new FakeAttemptReader();
  const inspector = new DlqInspector(attempts, budgets);
  const deadLetters = new InMemoryDeadLetterQueue();
  const processor = new DrainDlqProcessor(service, inspector, deadLetters);
  return { service, attempts, inspector, deadLetters, processor };
}

describe("RetryBudgetPolicy", () => {
  test("defaults to 8 attempts and honors per-account overrides", () => {
    const policy = new RetryBudgetPolicy(new Map([["acct-strict", 3]]));

    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    expect(policy.budgetFor("acct-other")).toBe(8);
    expect(policy.budgetFor("acct-strict")).toBe(3);
  });

  test("rejects non-positive budgets", () => {
    expect(() => new RetryBudgetPolicy(new Map([["acct-1", 0]]))).toThrow(RangeError);
  });
});

describe("DlqInspector", () => {
  test("marks a dispatch DLQ-bound only once its failed attempts reach the budget", async () => {
    const { service, attempts, inspector } = setup();
    const job = await service.ensureJobRecord(dispatchInput);

    attempts.record(job.id, failures(DEFAULT_RETRY_BUDGET - 1));
    expect(await inspector.evaluate(job)).toBeNull();

    attempts.record(job.id, failures(DEFAULT_RETRY_BUDGET));
    const endpoint = await inspector.evaluate(job);
    expect(endpoint?.endpointUrl).toBe(dispatchInput.metadata.endpointUrl);
    expect(endpoint?.attemptCount).toBe(8);
    expect(endpoint?.lastAttempts.map((attempt) => attempt.attemptNumber)).toEqual([8, 7, 6]);
    expect(endpoint?.lastAttempts[0]?.errorBody).toBe("attempt 8: endpoint returned 503");
  });

  test("does not mark a dispatch whose latest attempt completed or is still running", async () => {
    const { service, attempts, inspector } = setup();
    const job = await service.ensureJobRecord(dispatchInput);

    attempts.record(job.id, [...failures(8), "completed"]);
    expect(await inspector.evaluate(job)).toBeNull();

    attempts.record(job.id, [...failures(8), "running"]);
    expect(await inspector.evaluate(job)).toBeNull();
  });

  test("summarizes the past-budget endpoint count", async () => {
    const { service, attempts, inspector } = setup(new RetryBudgetPolicy(new Map([[accountId, 2]])));
    const job = await service.ensureJobRecord(dispatchInput);
    attempts.record(job.id, failures(2));

    const summary = await inspector.summarize([job]);
    expect(summary.count).toBe(1);
    expect(summary.endpoints[0]?.retryBudget).toBe(2);
  });
});

describe("DrainDlqProcessor", () => {
  test("moves past-budget endpoints to the DLQ once and records the drain run", async () => {
    const { service, attempts, deadLetters, processor } = setup();
    const dispatch = await service.ensureJobRecord(dispatchInput);
    const drain = await service.ensureJobRecord(drainInput);
    attempts.record(dispatch.id, failures(8));

    const first = await processor.process(drain, "worker-us-east-04");
    expect(first.moved.map((entry) => entry.deliveryJobId)).toEqual([dispatch.id]);
    expect(first.drainJob.status).toBe("completed");

    const second = await processor.process(drain, "worker-us-east-04");
    expect(second.moved).toEqual([]);
    expect(await deadLetters.listByBrief(briefId)).toHaveLength(1);
  });

  test("ignores dispatches from other accounts in the same brief", async () => {
    const { service, attempts, processor } = setup();
    const foreign = await service.ensureJobRecord({ ...dispatchInput, accountId: "acct-2" });
    const drain = await service.ensureJobRecord(drainInput);
    attempts.record(foreign.id, failures(8));

    const result = await processor.process(drain, "worker-us-east-04");
    expect(result.moved).toEqual([]);
  });

  test("rejects jobs that are not drain_dlq", async () => {
    const { service, processor } = setup();
    const dispatch = await service.ensureJobRecord(dispatchInput);

    await expect(processor.process(dispatch, "worker-us-east-04")).rejects.toBeInstanceOf(
      InvalidDrainJobError,
    );
  });
});
