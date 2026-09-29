import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobNotFoundError } from "../src/domain/errors";
import type { DeliveryWritePathFlags } from "../src/domain/delivery-attempt";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
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

function setup(flags?: Partial<DeliveryWritePathFlags>) {
  const jobs = new InMemoryJobRepository();
  const store = new InMemoryDeliveryAttemptStore();
  const rpc = new DeliveryAttemptRpc(
    jobs,
    store,
    flags
      ? {
          pilotAccountIds: flags.pilotAccountIds ?? new Set<string>(),
          rollbackAccountIds: flags.rollbackAccountIds ?? new Set<string>(),
        }
      : undefined,
  );
  return { jobs, store, rpc };
}

describe("DeliveryAttemptRpc", () => {
  test("defaults to the legacy path for every account", async () => {
    const { jobs, rpc } = setup();
    const job = await jobs.create(baseInput);

    const running = await rpc.markRunning(job.id, "worker-us-east-04");

    expect(rpc.usesAttemptPath(pilotAccount)).toBe(false);
    expect(running.status).toBe("running");
    expect(running.deliveryJobId).toBeUndefined();
  });

  test("appends one attempt per call for pilot accounts and keeps jobs.status current", async () => {
    const { jobs, store, rpc } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await jobs.create(baseInput);

    await rpc.markRunning(job.id, "worker-us-east-04");
    await rpc.markFailed(job.id, "endpoint timeout after 30s", {
      workerId: "worker-us-east-04",
      responseStatus: 503,
    });
    await rpc.retry(job.id);
    await rpc.markRunning(job.id, "worker-us-east-07");
    const final = await rpc.markCompleted(job.id, {
      workerId: "worker-us-east-07",
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    expect(final.status).toBe("completed");
    expect(final.retryCount).toBe(1);
    expect(final.deliveryJobId).toBeDefined();

    const attempts = await store.listAttempts(final.deliveryJobId ?? "");
    expect(attempts.map((a) => [a.attemptNumber, a.status])).toEqual([
      [1, "running"],
      [2, "failed"],
      [3, "queued"],
      [4, "running"],
      [5, "completed"],
    ]);
    expect(attempts[1]?.errorBody).toBe("endpoint timeout after 30s");
  });

  test("rollback flag forces the legacy path even for pilot accounts", async () => {
    const { jobs, rpc } = setup({
      pilotAccountIds: new Set([pilotAccount]),
      rollbackAccountIds: new Set([pilotAccount]),
    });
    const job = await jobs.create(baseInput);

    const result = await rpc.markRunning(job.id, "worker-us-east-04");

    expect(rpc.usesAttemptPath(pilotAccount)).toBe(false);
    expect(result.status).toBe("running");
    expect(result.deliveryJobId).toBeUndefined();
  });

  test("racing callers receive distinct, increasing attempt numbers", async () => {
    const { jobs, store, rpc } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await jobs.create(baseInput);
    const linked = await rpc.markRunning(job.id, "worker-0");

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => rpc.markRunning(job.id, `worker-${i + 1}`)),
    );

    const attempts = await store.listAttempts(linked.deliveryJobId ?? "");
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("duplicate jobs rows map to one intent", async () => {
    const { jobs, rpc } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const first = await jobs.create(baseInput);
    const duplicate = await jobs.create(baseInput);

    const [a, b] = await Promise.all([
      rpc.markRunning(first.id, "worker-a"),
      rpc.markRunning(duplicate.id, "worker-b"),
    ]);

    expect(a.deliveryJobId).toBeDefined();
    expect(b.deliveryJobId).toBe(a.deliveryJobId);
  });

  test("throws JobNotFoundError for unknown jobs", async () => {
    const { rpc } = setup({ pilotAccountIds: new Set([pilotAccount]) });

    await expect(rpc.retry("missing-job")).rejects.toBeInstanceOf(JobNotFoundError);
  });
});
