import { describe, expect, test } from "bun:test";
import { AccountRetryBudgetRegistry } from "../src/application/account-retry-budget";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-dlq",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

async function seedFailedAttempts(
  repo: InMemoryJobRepository,
  jobId: string,
  count: number,
): Promise<void> {
  for (let attemptNumber = 1; attemptNumber <= count; attemptNumber += 1) {
    await repo.insertAttempt({
      deliveryJobId: jobId,
      attemptNumber,
      status: "failed",
      errorBody: `attempt-${attemptNumber} timeout`,
    });
  }
}

describe("DrainDlqProcessor", () => {
  test("moves endpoints past the default 8-attempt budget into the DLQ", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const processor = new DrainDlqProcessor(service);
    const job = await service.ensureJobRecord(baseInput);
    await seedFailedAttempts(repo, job.id, 8);

    const result = await processor.process(baseInput.briefId, baseInput.accountId);
    const dead = await repo.findById(job.id);

    expect(result.movedJobIds).toEqual([job.id]);
    expect(result.drainJob.type).toBe("drain_dlq");
    expect(dead?.deadLetteredAt).toBeDefined();
    expect(await service.displayStatus(dead!)).toBe("dlq");
  });

  test("honors a per-account retry budget", async () => {
    const repo = new InMemoryJobRepository();
    const budgets = new AccountRetryBudgetRegistry();
    budgets.set(baseInput.accountId, 2);
    const service = new JobRecordService(repo, undefined, budgets);
    const processor = new DrainDlqProcessor(service);
    const job = await service.ensureJobRecord(baseInput);
    await seedFailedAttempts(repo, job.id, 2);

    const result = await processor.process(baseInput.briefId);
    expect(result.movedJobIds).toEqual([job.id]);
  });

  test("leaves jobs inside the budget queued for retry", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const processor = new DrainDlqProcessor(service);
    const job = await service.ensureJobRecord(baseInput);
    await seedFailedAttempts(repo, job.id, 7);

    const result = await processor.process(baseInput.briefId);
    expect(result.movedJobIds).toEqual([]);
    expect((await repo.findById(job.id))?.deadLetteredAt).toBeUndefined();
  });
});
