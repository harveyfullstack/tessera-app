import { describe, expect, test } from "bun:test";
import { DeadLetterQueue, deliveryTries } from "../src/application/dead-letter-queue";
import {
  DEAD_LETTERED_ERROR_MESSAGE,
  DeliveryAttemptRpc,
} from "../src/application/delivery-attempt-rpc";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { DEFAULT_RETRY_BUDGET, RetryBudgetPolicy } from "../src/application/retry-budget-policy";
import { UnexpectedJobTypeError } from "../src/domain/errors";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const pilotAccount = "acct-pilot";
const briefId = "50ce0002-0000-4000-a001-000000000001";
const workerId = "worker-us-east-04";

const webhookInput: CreateJobInput = {
  accountId: pilotAccount,
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

const drainInput: CreateJobInput = { ...webhookInput, type: "drain_dlq" };

function setup(
  options: { pilot?: boolean; budgets?: ReadonlyMap<string, number> } = {},
) {
  const jobs = new InMemoryJobRepository();
  const store = new InMemoryDeliveryAttemptStore();
  const rpc = new DeliveryAttemptRpc(jobs, store, {
    pilotAccountIds: new Set(options.pilot === false ? [] : [pilotAccount]),
    rollbackAccountIds: new Set<string>(),
  });
  const records = new JobRecordService(jobs, rpc, store);
  const processor = new DrainDlqProcessor(
    jobs,
    store,
    rpc,
    new RetryBudgetPolicy(options.budgets),
  );
  const dlq = new DeadLetterQueue(records, store);
  return { jobs, store, rpc, records, processor, dlq };
}

type Setup = ReturnType<typeof setup>;

// One real delivery try as the orchestrator records it: running, failed, queued.
async function failTries(rpc: DeliveryAttemptRpc, jobId: string, tries: number): Promise<void> {
  for (let n = 1; n <= tries; n++) {
    await rpc.markRunning(jobId, workerId);
    await rpc.markFailed(jobId, "endpoint timeout after 30s", {
      workerId,
      responseStatus: 503,
      errorBody: `503 body ${n}`,
    });
    await rpc.retry(jobId);
  }
}

async function drain({ jobs, processor }: Setup) {
  const drainJob = await jobs.create(drainInput);
  return processor.process(drainJob.id, workerId);
}

describe("RetryBudgetPolicy", () => {
  test("defaults to 8 and honors per-account overrides", () => {
    const policy = new RetryBudgetPolicy(new Map([["acct-strict", 3]]));

    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    expect(policy.budgetFor("acct-other")).toBe(8);
    expect(policy.budgetFor("acct-strict")).toBe(3);
  });

  test("rejects non-positive budgets", () => {
    expect(() => new RetryBudgetPolicy(new Map([["acct", 0]]))).toThrow(RangeError);
  });
});

describe("DrainDlqProcessor", () => {
  test("counts real delivery tries, not attempt rows", async () => {
    const ctx = setup();
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, DEFAULT_RETRY_BUDGET - 1);

    const linked = await ctx.jobs.findById(job.id);
    const attempts = await ctx.store.listAttempts(linked?.deliveryJobId ?? "");
    expect(attempts.length).toBe((DEFAULT_RETRY_BUDGET - 1) * 3);
    expect(deliveryTries(attempts)).toBe(DEFAULT_RETRY_BUDGET - 1);

    const result = await drain(ctx);
    expect(result.deadLetteredJobIds).toEqual([]);
  });

  test("moves a delivery past the retry budget to the DLQ", async () => {
    const ctx = setup();
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, DEFAULT_RETRY_BUDGET);

    const result = await drain(ctx);
    const moved = await ctx.jobs.findById(job.id);

    expect(result.deadLetteredJobIds).toEqual([job.id]);
    expect(result.drainJob.status).toBe("completed");
    expect(moved?.status).toBe("failed");
    expect(moved?.errorMessage).toBe(DEAD_LETTERED_ERROR_MESSAGE);
    expect(moved && (await ctx.records.displayStatus(moved))).toBe("dlq");
  });

  test("is idempotent once a delivery is dead-lettered", async () => {
    const ctx = setup();
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, DEFAULT_RETRY_BUDGET);

    await drain(ctx);
    const second = await drain(ctx);

    expect(second.deadLetteredJobIds).toEqual([]);
  });

  test("applies the account's configured budget", async () => {
    const ctx = setup({ budgets: new Map([[pilotAccount, 2]]) });
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, 2);

    const result = await drain(ctx);

    expect(result.deadLetteredJobIds).toEqual([job.id]);
  });

  test("leaves in-flight and completed deliveries alone", async () => {
    const ctx = setup({ budgets: new Map([[pilotAccount, 1]]) });
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, 1);
    await ctx.rpc.markRunning(job.id, workerId);

    expect((await drain(ctx)).deadLetteredJobIds).toEqual([]);

    await ctx.rpc.markCompleted(job.id, { workerId, responseStatus: 200 });
    expect((await drain(ctx)).deadLetteredJobIds).toEqual([]);
  });

  test("skips accounts on the legacy write path", async () => {
    const ctx = setup({ pilot: false });
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, DEFAULT_RETRY_BUDGET);

    const result = await drain(ctx);

    expect(result.deadLetteredJobIds).toEqual([]);
    expect((await ctx.jobs.findById(job.id))?.errorMessage).not.toBe(DEAD_LETTERED_ERROR_MESSAGE);
  });

  test("rejects jobs that are not drain_dlq", async () => {
    const ctx = setup();
    const job = await ctx.jobs.create(webhookInput);

    await expect(ctx.processor.process(job.id, workerId)).rejects.toBeInstanceOf(
      UnexpectedJobTypeError,
    );
  });
});

describe("DeadLetterQueue", () => {
  test("surfaces the endpoint and the last three attempt bodies per delivery job", async () => {
    const ctx = setup({ budgets: new Map([[pilotAccount, 4]]) });
    const job = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, job.id, 4);
    await drain(ctx);

    const summary = await ctx.dlq.summarizeBrief(briefId);
    const deliveryJobId = (await ctx.jobs.findById(job.id))?.deliveryJobId;
    const entry = summary.entries[0];

    expect(summary.count).toBe(1);
    expect(entry?.deliveryJobId).toBe(deliveryJobId ?? "");
    expect(entry?.endpointUrl).toBe(webhookInput.metadata.endpointUrl);
    expect(entry?.jobIds).toEqual([job.id]);
    expect(entry?.lastAttemptBodies.map((attempt) => attempt.body)).toEqual([
      "503 body 4",
      "503 body 3",
      "503 body 2",
    ]);
    expect(Object.keys(entry?.lastAttemptBodies[0] ?? {}).sort()).toEqual([
      "attemptNumber",
      "body",
      "deliveryJobId",
    ]);
  });

  test("filters ?status=dlq through the same derived display status", async () => {
    const ctx = setup({ budgets: new Map([[pilotAccount, 1]]) });
    const deadLettered = await ctx.jobs.create(webhookInput);
    await failTries(ctx.rpc, deadLettered.id, 1);
    await drain(ctx);

    const dlqJobs = await ctx.records.listByBriefWithDisplayStatus(briefId, "dlq");

    expect(dlqJobs.map((job) => job.id)).toEqual([deadLettered.id]);
    expect((await ctx.dlq.summarizeBrief("another-brief")).count).toBe(0);
  });
});
