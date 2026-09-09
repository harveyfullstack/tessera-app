import { describe, expect, test } from "bun:test";
import { AccountRetryBudget } from "../src/application/account-retry-budget";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobMetadata } from "../src/domain/job";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

async function exhaustBudget(
  service: JobRecordService,
  jobId: string,
  attempts: number,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await service.markRunning(jobId, `worker-${i}`);
    await service.markFailed(jobId, `failure ${i + 1}`, {
      workerId: `worker-${i}`,
      errorBody: `endpoint body ${i + 1}`,
    });
  }
}

describe("DrainDlqProcessor", () => {
  test("moves endpoints past the default 8-attempt budget onto drain_dlq", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const processor = new DrainDlqProcessor(service);
    const job = await service.ensureWebhookDispatchJob("acct-1", "brief-dlq", metadata);

    await exhaustBudget(service, job.id, 8);

    const result = await processor.drain("acct-1", "brief-dlq");

    expect(result.movedJobIds).toEqual([job.id]);
    expect(result.drainJob?.type).toBe("drain_dlq");
    expect(result.dlq.pastBudgetCount).toBe(1);
    expect(result.dlq.endpoints).toEqual([
      {
        endpointUrl: metadata.endpointUrl,
        attemptBodies: ["endpoint body 8", "endpoint body 7", "endpoint body 6"],
      },
    ]);
  });

  test("honors a per-account retry budget override", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const budgets = new AccountRetryBudget();
    budgets.set("acct-low", 2);
    const processor = new DrainDlqProcessor(service, budgets);
    const job = await service.ensureWebhookDispatchJob("acct-low", "brief-low", metadata);

    await exhaustBudget(service, job.id, 2);

    const result = await processor.drain("acct-low", "brief-low");
    expect(result.dlq.pastBudgetCount).toBe(1);
    expect(result.movedJobIds).toEqual([job.id]);
  });

  test("does not drain a completed endpoint that used the full budget", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const processor = new DrainDlqProcessor(service);
    const job = await service.ensureWebhookDispatchJob("acct-1", "brief-ok", metadata);

    await exhaustBudget(service, job.id, 7);
    await service.markCompleted(job.id, { workerId: "worker-ok", responseStatus: 200 });

    const result = await processor.drain("acct-1", "brief-ok");
    expect(result.drainJob).toBeNull();
    expect(result.dlq.pastBudgetCount).toBe(0);
  });
});
