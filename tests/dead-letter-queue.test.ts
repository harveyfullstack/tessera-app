import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import {
  DEFAULT_RETRY_BUDGET,
  DELIVERY_RETRY_BUDGETS_ENV,
  DeliveryRetryBudget,
} from "../src/application/delivery-retry-budget";
import { DeliverySplitFlags } from "../src/application/delivery-split-flags";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobRecord } from "../src/domain/job";

const accountId = "acct-1";
const briefId = "50ce0002-0000-4000-a001-000000000001";
const endpointUrl = "https://hooks.dana-fintech.com/tessera";

const baseRequest = {
  accountId,
  briefId,
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl,
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-us-east-04",
} as const;

const pilotFlags = new DeliverySplitFlags({ pilotAccountIds: [accountId], rollbackAccountIds: [] });

function setup(flags: DeliverySplitFlags, budget = new DeliveryRetryBudget()) {
  const repo = new InMemoryJobRepository();
  const rpc = new DeliveryAttemptRpc(repo, new InMemoryDeliveryAttemptRepository(), flags);
  const service = new JobRecordService(repo, rpc, budget);
  return { service, delivery: new DeliveryOrchestrator(service) };
}

async function failTimes(delivery: DeliveryOrchestrator, times: number): Promise<JobRecord> {
  let last: JobRecord | undefined;
  for (let i = 0; i < times; i += 1) {
    last = await delivery.deliver({ ...baseRequest, simulateFailure: true });
  }
  if (!last) {
    throw new Error("failTimes needs at least one failure");
  }
  return last;
}

describe("DeliveryRetryBudget", () => {
  test("defaults to 8 attempts", () => {
    expect(DEFAULT_RETRY_BUDGET).toBe(8);
    expect(new DeliveryRetryBudget().forAccount(accountId)).toBe(8);
  });

  test("reads per-account overrides and ignores malformed entries", () => {
    const budget = DeliveryRetryBudget.fromEnv({
      [DELIVERY_RETRY_BUDGETS_ENV]: "acct-1=3, acct-2=zero ,acct-3=-1,=4",
    });
    expect(budget.forAccount("acct-1")).toBe(3);
    expect(budget.forAccount("acct-2")).toBe(8);
    expect(budget.forAccount("acct-3")).toBe(8);
  });
});

describe("JobRecordService DLQ", () => {
  test("a pilot job is not DLQ-bound before its 8th failed execution", async () => {
    const { service, delivery } = setup(pilotFlags);
    const job = await failTimes(delivery, DEFAULT_RETRY_BUDGET - 1);

    // 7 executions wrote 21 transition rows; the budget counts executions only.
    expect(await service.dlqEntry(job)).toBeNull();
  });

  test("a pilot job past its budget moves to the DLQ with its last three outcome bodies", async () => {
    const { service, delivery } = setup(pilotFlags);
    const job = await failTimes(delivery, DEFAULT_RETRY_BUDGET);

    const entry = await service.dlqEntry(job);
    expect(entry).not.toBeNull();
    expect(entry?.endpointUrl).toBe(endpointUrl);
    expect(entry?.executionCount).toBe(DEFAULT_RETRY_BUDGET);
    expect(entry?.retryBudget).toBe(DEFAULT_RETRY_BUDGET);
    expect(entry?.lastAttempts).toHaveLength(3);
    expect(entry?.lastAttempts.every((attempt) => attempt.status === "failed")).toBe(true);
    expect(entry?.lastAttempts.map((attempt) => attempt.attemptNumber)).toEqual([24, 21, 18]);
    expect(Object.keys(entry?.lastAttempts[0] ?? {})).not.toContain("id");

    const rows = await service.listByBrief(briefId);
    const drainJob = rows.find((row) => row.type === "drain_dlq");
    expect(drainJob?.status).toBe("completed");
    expect(drainJob?.parentJobId).toBe(job.id);
    expect(drainJob?.metadata.endpointUrl).toBe(endpointUrl);
  });

  test("legacy accounts use jobs.retry_count and expose no attempt bodies", async () => {
    const { service, delivery } = setup(new DeliverySplitFlags());
    const job = await failTimes(delivery, DEFAULT_RETRY_BUDGET);

    const entry = await service.dlqEntry(job);
    expect(entry?.executionCount).toBe(DEFAULT_RETRY_BUDGET);
    expect(entry?.lastAttempts).toEqual([]);
  });

  test("honors a per-account budget", async () => {
    const { service, delivery } = setup(pilotFlags, new DeliveryRetryBudget([[accountId, 2]]));
    const job = await failTimes(delivery, 2);

    expect((await service.dlqEntry(job))?.retryBudget).toBe(2);
  });

  test("a job that later completes is not DLQ-bound", async () => {
    const { service, delivery } = setup(pilotFlags);
    await failTimes(delivery, DEFAULT_RETRY_BUDGET);
    const completed = await delivery.deliver({ ...baseRequest });

    expect(await service.dlqEntry(completed)).toBeNull();
  });

  test("successful executions between failures do not count against the budget", async () => {
    const pilot = setup(pilotFlags);
    const legacy = setup(new DeliverySplitFlags());
    for (const { delivery } of [pilot, legacy]) {
      await failTimes(delivery, DEFAULT_RETRY_BUDGET - 1);
      await delivery.deliver({ ...baseRequest });
    }
    const pilotJob = await failTimes(pilot.delivery, 1);
    const legacyJob = await failTimes(legacy.delivery, 1);

    // 9 executions, 8 of them failed: both paths agree the job is DLQ-bound.
    expect((await pilot.service.dlqEntry(pilotJob))?.executionCount).toBe(DEFAULT_RETRY_BUDGET);
    expect((await legacy.service.dlqEntry(legacyJob))?.executionCount).toBe(DEFAULT_RETRY_BUDGET);
  });

  test("dlqSummary counts past-budget jobs and skips drain_dlq jobs", async () => {
    const { service, delivery } = setup(pilotFlags);
    await failTimes(delivery, DEFAULT_RETRY_BUDGET + 1);

    const rows = await service.listByBrief(briefId);
    const summary = await service.dlqSummary(rows);
    expect(rows).toHaveLength(2);
    expect(summary.count).toBe(1);
    expect(summary.entries[0]?.executionCount).toBe(DEFAULT_RETRY_BUDGET + 1);
  });

  test("draining twice does not re-run a completed drain_dlq job", async () => {
    const { service, delivery } = setup(pilotFlags);
    const job = await failTimes(delivery, DEFAULT_RETRY_BUDGET);

    const first = await service.drainDlq(job, "worker-us-east-07");
    const second = await service.drainDlq(job, "worker-us-east-07");
    expect(second?.id).toBe(first?.id);
    expect(second?.updatedAt).toEqual(first?.updatedAt);
  });
});
