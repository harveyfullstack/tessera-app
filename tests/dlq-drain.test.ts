import { describe, expect, test } from "bun:test";
import { loadBriefJobs, briefIdFromJobsPath } from "../src/api/brief-jobs";
import { DlqDrainProcessor } from "../src/application/dlq-drain-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { AccountRetryBudgets } from "../src/domain/retry-budget";
import type { DeliveryAttempt } from "../src/domain/delivery-schema";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function jobInput(endpointUrl: string, type: CreateJobInput["type"] = "dispatch_webhook"): CreateJobInput {
  return {
    accountId: "acct-1",
    briefId: "brief-1",
    type,
    metadata: { ...metadata, endpointUrl },
  };
}

async function addAttempts(
  store: InMemoryDeliveryAttemptStore,
  deliveryJobId: string,
  count: number,
  bodyAt: (attemptNumber: number) => string | undefined,
): Promise<void> {
  for (let attemptNumber = 1; attemptNumber <= count; attemptNumber += 1) {
    const errorBody = bodyAt(attemptNumber);
    const attempt: DeliveryAttempt = {
      id: `${deliveryJobId}-${attemptNumber}`,
      deliveryJobId,
      attemptNumber,
      status: "failed",
      ...(errorBody !== undefined ? { errorBody } : {}),
    };
    await store.insert(attempt);
  }
}

describe("DlqDrainProcessor", () => {
  test("moves endpoints past the account retry budget and keeps the last three bodies", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const budgets = new AccountRetryBudgets(new Map([["acct-1", 2]]));
    const processor = new DlqDrainProcessor(jobs, attempts, budgets);
    const healthy = await jobs.create(jobInput("https://hooks.example.test/healthy"));
    const exhausted = await jobs.create(jobInput("https://hooks.example.test/exhausted"));
    await addAttempts(attempts, healthy.id, 2, (n) => `healthy-${n}`);
    await addAttempts(attempts, exhausted.id, 5, (n) => (n === 2 ? undefined : `body-${n}`));
    const drainJob = await jobs.create(jobInput("https://hooks.example.test/drain", "drain_dlq"));

    const moved = await processor.drain(drainJob);

    expect(moved.map((endpoint) => endpoint.endpointUrl)).toEqual(["https://hooks.example.test/exhausted"]);
    expect(moved[0]?.bodies).toEqual(["body-5", "body-4", "body-3"]);
    expect(processor.drainedEndpoints("brief-1")).toEqual(moved);
    await expect(processor.drain(healthy)).rejects.toThrow(/drain_dlq processor cannot run/);
  });

  test("uses eight attempts as the default budget", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const processor = new DlqDrainProcessor(jobs, attempts, new AccountRetryBudgets());
    const job = await jobs.create(jobInput("https://hooks.example.test/default"));
    await addAttempts(attempts, job.id, 8, (n) => `body-${n}`);

    expect(await processor.endpointsPastBudget("brief-1")).toEqual([]);

    await attempts.insert({
      id: `${job.id}-9`,
      deliveryJobId: job.id,
      attemptNumber: 9,
      status: "failed",
      errorBody: "body-9",
    });
    const endpoints = await processor.endpointsPastBudget("brief-1");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.bodies).toEqual(["body-9", "body-8", "body-7"]);
  });

  test("GET jobs reports the DLQ count and can filter to those endpoints", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const records = new JobRecordService(jobs, attempts);
    const processor = new DlqDrainProcessor(jobs, attempts, new AccountRetryBudgets(new Map([["acct-1", 1]])));
    const visible = await jobs.create(jobInput("https://hooks.example.test/dlq"));
    await jobs.create(jobInput("https://hooks.example.test/ok"));
    await addAttempts(attempts, visible.id, 2, (n) => `err-${n}`);

    const all = await loadBriefJobs("brief-1", null, records, processor);
    const filtered = await loadBriefJobs("brief-1", "dlq", records, processor);

    expect(briefIdFromJobsPath("/briefs/brief-1/jobs")).toBe("brief-1");
    expect(briefIdFromJobsPath("/briefs/brief-1/other")).toBeNull();
    expect(all.dlq.count).toBe(1);
    expect(all.dlq.endpoints).toEqual([
      { endpointUrl: "https://hooks.example.test/dlq", bodies: ["err-2", "err-1"] },
    ]);
    expect(all.jobs).toHaveLength(2);
    expect(filtered.jobs.map((job) => job.id)).toEqual([visible.id]);
  });
});
