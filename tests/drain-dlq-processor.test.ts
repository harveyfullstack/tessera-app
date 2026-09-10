import { describe, expect, test } from "bun:test";
import { createAppFetch } from "../src/api/app";
import { createDeliveryRuntime } from "../src/application/delivery-runtime";
import { DEFAULT_RETRY_BUDGET } from "../src/application/retry-budget";
import type { CreateJobInput } from "../src/domain/job";

const accountId = "acct-1";
const briefId = "50ce0002-0000-4000-a001-000000000001";
const endpointUrl = "https://hooks.dana-fintech.com/tessera";

const baseInput: CreateJobInput = {
  accountId,
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

async function exhaustBudget(
  jobRecords: ReturnType<typeof createDeliveryRuntime>["jobRecords"],
  jobId: string,
  attempts: number,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await jobRecords.markRunning(jobId, `worker-${i}`);
    await jobRecords.markFailed(jobId, `attempt ${i + 1} failed`, {
      errorBody: `body-${i + 1}`,
      responseStatus: 503,
    });
  }
}

describe("DrainDlqProcessor", () => {
  test("moves endpoints that have reached the default 8-attempt budget into the DLQ", async () => {
    const runtime = createDeliveryRuntime();
    const job = await runtime.jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(runtime.jobRecords, job.id, DEFAULT_RETRY_BUDGET);

    const result = await runtime.drainDlq.process({
      accountId,
      briefId,
      workerId: "dlq-processor",
    });

    expect(result.job.type).toBe("drain_dlq");
    expect(result.job.status).toBe("completed");
    expect(result.movedJobIds).toEqual([job.id]);
    expect(runtime.dlq.isBound(job.id)).toBe(true);
    expect(runtime.dlq.listByBrief(briefId)[0]?.lastAttemptBodies).toEqual([
      "attempt 8 failed",
      "attempt 7 failed",
      "attempt 6 failed",
    ]);
  });

  test("honors a per-account retry budget", async () => {
    const runtime = createDeliveryRuntime();
    runtime.budgets.setBudget(accountId, 2);
    const job = await runtime.jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(runtime.jobRecords, job.id, 2);

    const result = await runtime.drainDlq.process({
      accountId,
      briefId,
      workerId: "dlq-processor",
    });

    expect(result.movedJobIds).toEqual([job.id]);
  });

  test("does not move endpoints still inside the retry budget", async () => {
    const runtime = createDeliveryRuntime();
    const job = await runtime.jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(runtime.jobRecords, job.id, 2);

    const result = await runtime.drainDlq.process({
      accountId,
      briefId,
      workerId: "dlq-processor",
    });

    expect(result.movedJobIds).toEqual([]);
    expect(runtime.dlq.isBound(job.id)).toBe(false);
  });
});

describe("GET /briefs/:briefId/jobs", () => {
  test("includes a dlq field with past-budget count and the last three attempt bodies", async () => {
    const runtime = createDeliveryRuntime();
    runtime.budgets.setBudget(accountId, 3);
    const job = await runtime.jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(runtime.jobRecords, job.id, 3);
    const fetchHandler = createAppFetch(runtime, accountId);

    const response = await fetchHandler(
      new Request(`http://tessera.test/briefs/${briefId}/jobs`),
    );
    const payload = (await response.json()) as {
      jobs: Array<{ id: string }>;
      dlq: { pastBudgetCount: number; endpoints: Array<{ endpointUrl: string; attemptBodies: string[] }> };
    };

    expect(payload.jobs.map((row) => row.id)).toEqual([job.id]);
    expect(payload.dlq.pastBudgetCount).toBe(1);
    expect(payload.dlq.endpoints).toEqual([
      {
        endpointUrl,
        attemptBodies: ["attempt 3 failed", "attempt 2 failed", "attempt 1 failed"],
      },
    ]);
  });

  test("filters to DLQ-bound endpoints through ?status=dlq", async () => {
    const runtime = createDeliveryRuntime();
    runtime.budgets.setBudget(accountId, 2);
    const bound = await runtime.jobRecords.ensureJobRecord(baseInput);
    const healthy = await runtime.jobs.create({
      ...baseInput,
      metadata: {
        ...baseInput.metadata,
        endpointUrl: "https://hooks.healthy.example/tessera",
        payloadHash: "sha256:healthy",
      },
    });
    await exhaustBudget(runtime.jobRecords, bound.id, 2);
    const fetchHandler = createAppFetch(runtime, accountId);

    const all = (await (
      await fetchHandler(new Request(`http://tessera.test/briefs/${briefId}/jobs`))
    ).json()) as { jobs: Array<{ id: string }> };
    const dlqOnly = (await (
      await fetchHandler(new Request(`http://tessera.test/briefs/${briefId}/jobs?status=dlq`))
    ).json()) as { jobs: Array<{ id: string }> };

    expect(all.jobs.map((row) => row.id).sort()).toEqual([bound.id, healthy.id].sort());
    expect(dlqOnly.jobs.map((row) => row.id)).toEqual([bound.id]);
  });
});
