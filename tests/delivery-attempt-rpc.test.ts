import { describe, expect, test } from "bun:test";
import { createJobServiceGraph } from "../src/application/job-service-factory";
import { InMemoryDeliverySplitFlags } from "../src/application/delivery-split-flags";
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

describe("DeliveryAttemptRpc", () => {
  test("assigns monotonically increasing attempt numbers to racing callers", async () => {
    const { jobRecords, attempts, attemptRpc } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);

    const [first, second] = await Promise.all([
      attemptRpc.markRunning(job.id, "worker-a"),
      attemptRpc.markRunning(job.id, "worker-b"),
    ]);

    const history = await attempts.listByDeliveryJobId(job.id);
    const numbers = history.map((row) => row.attemptNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
    expect(new Set([first.workerId, second.workerId])).toEqual(new Set(["worker-a", "worker-b"]));
  });

  test("skips attempt inserts when the per-account rollback flag is on", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    flags.enableRollback(baseInput.accountId);
    const { jobRecords, attempts } = createJobServiceGraph({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    const failed = await jobRecords.markFailed(job.id, "endpoint timeout after 30s");

    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("endpoint timeout after 30s");
    expect(await attempts.listByDeliveryJobId(job.id)).toEqual([]);
  });

  test("checks the rollback flag only inside the RPC boundary", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    const { jobRecords, attempts } = createJobServiceGraph({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markCompleted(job.id, {
      workerId: "worker-us-east-04",
      responseStatus: 200,
      responseLatencyMs: 187,
    });
    flags.enableRollback(baseInput.accountId);
    await jobRecords.retry(job.id);

    const history = await attempts.listByDeliveryJobId(job.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("completed");
  });
});
