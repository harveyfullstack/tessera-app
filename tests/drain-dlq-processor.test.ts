import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY_BUDGET,
  DrainDlqProcessor,
  parseAccountRetryBudgets,
} from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const endpoint = {
  accountId: "acct-default",
  briefId: "brief-1",
  type: "dispatch_webhook" as const,
  metadata: {
    customerId: "customer-1",
    subscriptionId: "subscription-1",
    endpointUrl: "https://hooks.example.com",
    eventType: "anomaly.detected",
    payloadHash: "sha256:test",
  },
};

describe("DrainDlqProcessor", () => {
  test("moves failed endpoints to the DLQ at the default retry budget", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord(endpoint);
    const processor = new DrainDlqProcessor(service);

    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    await failAttempts(service, job.id, DEFAULT_RETRY_BUDGET);

    const drained = await processor.process(endpoint.accountId, endpoint.briefId);
    const view = await processor.listByBrief(endpoint.accountId, endpoint.briefId, "dlq");

    expect(drained).toHaveLength(1);
    expect(drained[0]?.type).toBe("drain_dlq");
    expect(view.dlq.pastBudgetCount).toBe(1);
    expect(view.jobs).toHaveLength(1);
    expect(view.jobs[0]?.status).toBe("dlq");
    expect(view.jobs[0]?.dlq?.attemptBodies).toEqual([
      "failure-body-6",
      "failure-body-7",
      "failure-body-8",
    ]);
  });

  test("uses account-specific retry budgets and does not duplicate DLQ entries", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const accountJob = await service.ensureJobRecord({
      ...endpoint,
      accountId: "acct-short-budget",
      briefId: "brief-2",
    });
    const processor = new DrainDlqProcessor(service, {
      perAccount: { "acct-short-budget": 2 },
    });

    await failAttempts(service, accountJob.id, 2);
    expect(await processor.process("acct-short-budget", "brief-2")).toHaveLength(1);
    expect(await processor.process("acct-short-budget", "brief-2")).toHaveLength(0);
    expect((await processor.listByBrief("acct-short-budget", "brief-2")).dlq.pastBudgetCount).toBe(1);
  });

  test("lists jobs only for the requested account", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    await service.ensureJobRecord(endpoint);
    await service.ensureJobRecord({ ...endpoint, accountId: "acct-other" });
    const processor = new DrainDlqProcessor(service);

    expect((await processor.listByBrief(endpoint.accountId, endpoint.briefId)).jobs).toHaveLength(1);
    expect((await processor.listByBrief("acct-unknown", endpoint.briefId)).jobs).toHaveLength(0);
  });

  test("parses per-account retry budget configuration", () => {
    expect(parseAccountRetryBudgets('{"acct-1":12}')).toEqual({ "acct-1": 12 });
    expect(parseAccountRetryBudgets(undefined)).toEqual({});
  });
});

async function failAttempts(
  service: JobRecordService,
  jobId: string,
  count: number,
): Promise<void> {
  for (let attempt = 1; attempt <= count; attempt += 1) {
    await service.retry(jobId);
    await service.markFailed(jobId, `failure-${attempt}`, {
      responseStatus: 503,
      errorBody: `failure-body-${attempt}`,
    });
  }
}
