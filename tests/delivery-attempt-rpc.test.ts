import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc, type DeliverySplitFlags } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { PilotAccountLimitError } from "../src/domain/errors";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const pilotAccount = "acct-pilot";

const baseInput: CreateJobInput = {
  accountId: pilotAccount,
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

function setup(flags?: Partial<DeliverySplitFlags>) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(jobs, attempts, {
    pilotAccountIds: flags?.pilotAccountIds ?? new Set<string>(),
    rollbackAccountIds: flags?.rollbackAccountIds ?? new Set<string>(),
  });
  return { jobs, attempts, rpc, service: new JobRecordService(jobs, rpc) };
}

describe("DeliveryAttemptRpc", () => {
  test("keeps the legacy path when the account is not a pilot", async () => {
    const { jobs, attempts, service } = setup();
    const job = await service.ensureJobRecord(baseInput);

    const running = await service.markRunning(job.id, "worker-us-east-04");

    expect(running.status).toBe("running");
    const stored = await jobs.findById(job.id);
    expect(stored?.deliveryJobId).toBeUndefined();
    expect(await attempts.latestAttemptNumber(job.id)).toBe(0);
  });

  test("appends one attempt per call for pilot accounts and mirrors jobs.status", async () => {
    const { jobs, attempts, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s", { responseStatus: 503 });
    await service.retry(job.id);
    const final = await service.markCompleted(job.id, { workerId: "worker-us-east-07", responseStatus: 200 });

    expect(final.status).toBe("completed");
    expect(final.retryCount).toBe(1);

    const deliveryJobId = (await jobs.findById(job.id))?.deliveryJobId;
    expect(deliveryJobId).toBeDefined();
    const rows = await attempts.listAttempts(deliveryJobId ?? "");
    expect(rows.map((row) => [row.attemptNumber, row.status])).toEqual([
      [1, "running"],
      [2, "failed"],
      [3, "queued"],
      [4, "completed"],
    ]);
    expect(rows[1]?.errorBody).toBe("endpoint timeout after 30s");
  });

  test("rollback flag forces the legacy path even for a pilot account", async () => {
    const { jobs, service } = setup({
      pilotAccountIds: new Set([pilotAccount]),
      rollbackAccountIds: new Set([pilotAccount]),
    });
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");

    expect((await jobs.findById(job.id))?.deliveryJobId).toBeUndefined();
  });

  test("racing callers receive distinct, monotonically increasing attempt numbers", async () => {
    const { jobs, attempts, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await service.ensureJobRecord(baseInput);

    await Promise.all([
      service.markRunning(job.id, "worker-a"),
      service.markRunning(job.id, "worker-b"),
      service.markRunning(job.id, "worker-c"),
      service.markRunning(job.id, "worker-d"),
    ]);

    const deliveryJobId = (await jobs.findById(job.id))?.deliveryJobId ?? "";
    const numbers = (await attempts.listAttempts(deliveryJobId)).map((row) => row.attemptNumber);
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  test("rejects more than three pilot accounts", () => {
    expect(() =>
      setup({ pilotAccountIds: new Set(["a", "b", "c", "d"]) }),
    ).toThrow(PilotAccountLimitError);
  });
});
