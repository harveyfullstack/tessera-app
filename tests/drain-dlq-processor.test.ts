import { describe, expect, test } from "bun:test";
import { createJobServiceGraph } from "../src/application/job-service-factory";
import { DEFAULT_RETRY_BUDGET } from "../src/application/retry-budget-policy";
import type { CreateJobInput } from "../src/domain/job";

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

async function exhaustBudget(
  jobRecords: ReturnType<typeof createJobServiceGraph>["jobRecords"],
  jobId: string,
  attempts: number,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    await jobRecords.markFailed(jobId, `attempt ${index + 1} failed`, {
      errorBody: `endpoint body ${index + 1}`,
    });
  }
}

describe("DrainDlqProcessor", () => {
  test("moves endpoints that exhaust the default 8-attempt budget into the DLQ", async () => {
    const { jobRecords, drainDlq } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(jobRecords, job.id, DEFAULT_RETRY_BUDGET);

    const drainJob = await drainDlq.process(baseInput.accountId, baseInput.briefId);
    const listing = await drainDlq.listJobs(baseInput.briefId);

    expect(drainJob.type).toBe("drain_dlq");
    expect(drainJob.status).toBe("completed");
    expect(listing.dlq.pastBudgetCount).toBe(1);
    expect(listing.dlq.endpoints).toEqual([
      {
        endpointUrl: baseInput.metadata.endpointUrl,
        attemptBodies: ["endpoint body 6", "endpoint body 7", "endpoint body 8"],
      },
    ]);
  });

  test("honors a per-account retry budget", async () => {
    const { jobRecords, drainDlq, budgets } = createJobServiceGraph();
    budgets.setBudget(baseInput.accountId, 2);
    const job = await jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(jobRecords, job.id, 2);

    await drainDlq.process(baseInput.accountId, baseInput.briefId);
    const listing = await drainDlq.listJobs(baseInput.briefId);

    expect(listing.dlq.pastBudgetCount).toBe(1);
    expect(listing.dlq.endpoints[0]?.attemptBodies).toEqual(["endpoint body 1", "endpoint body 2"]);
  });

  test("does not move a completed endpoint even when attempt volume is high", async () => {
    const { jobRecords, drainDlq, budgets } = createJobServiceGraph();
    budgets.setBudget(baseInput.accountId, 2);
    const job = await jobRecords.ensureJobRecord(baseInput);
    await jobRecords.markFailed(job.id, "first failed", { errorBody: "body 1" });
    await jobRecords.markCompleted(job.id, { responseStatus: 200, errorBody: "ok" });

    await drainDlq.process(baseInput.accountId, baseInput.briefId);
    const listing = await drainDlq.listJobs(baseInput.briefId);

    expect(listing.dlq.pastBudgetCount).toBe(0);
    expect(listing.dlq.endpoints).toEqual([]);
  });

  test("GET listing can filter to DLQ-bound endpoints through ?status=dlq", async () => {
    const { jobRecords, drainDlq, budgets } = createJobServiceGraph();
    budgets.setBudget(baseInput.accountId, 2);
    const bound = await jobRecords.ensureJobRecord(baseInput);
    await exhaustBudget(jobRecords, bound.id, 2);

    await drainDlq.process(baseInput.accountId, baseInput.briefId);
    const all = await drainDlq.listJobs(baseInput.briefId);
    const filtered = await drainDlq.listJobs(baseInput.briefId, { status: "dlq" });

    expect(all.jobs.some((job) => job.type === "drain_dlq")).toBe(true);
    expect(filtered.jobs.map((job) => job.id)).toEqual([bound.id]);
    expect(filtered.dlq.pastBudgetCount).toBe(1);
  });
});
