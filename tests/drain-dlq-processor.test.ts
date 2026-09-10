import { describe, expect, test } from "bun:test";
import { DEFAULT_RETRY_BUDGET } from "../src/application/account-retry-budgets";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import type { CreateJobInput, JobStatus } from "../src/domain/job";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-dlq",
  type: "dispatch_webhook",
  metadata,
};

async function seedAttempts(
  repo: InMemoryJobRepository,
  jobId: string,
  count: number,
  status: JobStatus = "failed",
): Promise<void> {
  for (let attemptNumber = 1; attemptNumber <= count; attemptNumber += 1) {
    await repo.insertAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status,
      errorBody: `body-${attemptNumber}`,
    });
  }
}

describe("DrainDlqProcessor", () => {
  test("defaults the retry budget to 8 and moves past-budget endpoints to the DLQ", async () => {
    const repo = new InMemoryJobRepository();
    const jobRecords = new JobRecordService(repo);
    const processor = new DrainDlqProcessor(repo, jobRecords);
    const job = await jobRecords.ensureJobRecord(baseInput);

    expect(processor.retryBudgetFor(baseInput.accountId)).toBe(DEFAULT_RETRY_BUDGET);
    await seedAttempts(repo, job.id, DEFAULT_RETRY_BUDGET);

    const drainJob = await processor.process(baseInput.accountId, baseInput.briefId);
    const dlq = await processor.summarize(baseInput.accountId, baseInput.briefId);

    expect(drainJob.type).toBe("drain_dlq");
    expect(drainJob.status).toBe("completed");
    expect(drainJob.metadata.dlqEndpoints).toEqual([
      {
        endpointUrl: metadata.endpointUrl,
        jobId: job.id,
        lastAttemptBodies: ["body-8", "body-7", "body-6"],
      },
    ]);
    expect(dlq.pastBudgetCount).toBe(1);
    expect(dlq.endpoints[0]?.lastAttemptBodies).toEqual(["body-8", "body-7", "body-6"]);
  });

  test("honors a per-account retry budget and leaves completed jobs off the DLQ", async () => {
    const repo = new InMemoryJobRepository();
    const jobRecords = new JobRecordService(repo);
    const processor = new DrainDlqProcessor(repo, jobRecords);
    processor.setRetryBudget(baseInput.accountId, 2);

    const failed = await jobRecords.ensureJobRecord(baseInput);
    const completed = await jobRecords.ensureJobRecord({
      ...baseInput,
      accountId: "acct-2",
      metadata: { ...metadata, endpointUrl: "https://hooks.ok.com/tessera" },
    });

    await seedAttempts(repo, failed.id, 2, "failed");
    await seedAttempts(repo, completed.id, 4, "completed");

    const acct1 = await processor.summarize(baseInput.accountId, baseInput.briefId);
    const acct2 = await processor.summarize("acct-2", baseInput.briefId);

    expect(acct1.pastBudgetCount).toBe(1);
    expect(acct2.pastBudgetCount).toBe(0);
  });

  test("GET-shaped list includes dlq and supports ?status=dlq", async () => {
    const repo = new InMemoryJobRepository();
    const jobRecords = new JobRecordService(repo);
    const processor = new DrainDlqProcessor(repo, jobRecords);
    processor.setRetryBudget(baseInput.accountId, 3);

    const bound = await jobRecords.ensureJobRecord(baseInput);
    const healthy = await jobRecords.ensureJobRecord({
      ...baseInput,
      briefId: "brief-other",
      metadata: { ...metadata, endpointUrl: "https://hooks.healthy.com/tessera" },
    });

    await seedAttempts(repo, bound.id, 3, "failed");
    await seedAttempts(repo, healthy.id, 1, "completed");

    const all = await processor.listJobs(baseInput.accountId, baseInput.briefId);
    const filtered = await processor.listJobs(baseInput.accountId, baseInput.briefId, "dlq");

    expect(all.dlq.pastBudgetCount).toBe(1);
    expect(all.jobs.some((job) => job.id === bound.id)).toBe(true);
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0]?.id).toBe(bound.id);
    expect(filtered.dlq.endpoints[0]?.lastAttemptBodies).toEqual(["body-3", "body-2", "body-1"]);
  });
});
