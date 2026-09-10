import { describe, expect, test } from "bun:test";
import { createDeliveryRuntime } from "../src/application/delivery-runtime";
import { InMemoryDeliverySplitFlags } from "../src/application/delivery-split-flags";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-repository";

class ContendedAttemptRepository extends InMemoryDeliveryAttemptRepository {
  private firstWave: Array<() => void> = [];
  private released = false;

  override async nextAttemptNumber(deliveryJobId: string): Promise<number> {
    const next = await super.nextAttemptNumber(deliveryJobId);
    if (this.released || next !== 1) {
      return next;
    }

    await new Promise<void>((resolve) => {
      this.firstWave.push(resolve);
      if (this.firstWave.length >= 2) {
        this.released = true;
        for (const release of this.firstWave) {
          release();
        }
      }
    });
    return next;
  }
}

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
  test("assigns monotonically increasing attempt_number to racing callers", async () => {
    const { jobRecords, deliveryAttempts } = createDeliveryRuntime({
      deliveryAttempts: new ContendedAttemptRepository(),
    });
    const job = await jobRecords.ensureJobRecord(baseInput);

    const [first, second] = await Promise.all([
      jobRecords.markRunning(job.id, "worker-a"),
      jobRecords.markRunning(job.id, "worker-b"),
    ]);

    const history = await deliveryAttempts.listByDeliveryJobId(job.id);
    expect(history.map((row) => row.attemptNumber).sort()).toEqual([1, 2]);
    expect(new Set([first.workerId, second.workerId])).toEqual(new Set(["worker-a", "worker-b"]));
  });

  test("checks the rollback flag only inside the RPC write path", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    const { jobRecords, deliveryAttempts, jobs } = createDeliveryRuntime({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markCompleted(job.id, { responseStatus: 200, responseLatencyMs: 12 });
    expect(await deliveryAttempts.listByDeliveryJobId(job.id)).toHaveLength(1);

    flags.enableRollback(baseInput.accountId);
    const rolledBack = await jobRecords.markFailed(job.id, "rolled back path");
    expect(await deliveryAttempts.listByDeliveryJobId(job.id)).toHaveLength(1);
    expect((await jobs.findById(job.id))?.status).toBe("failed");
    expect(rolledBack.status).toBe("failed");
  });
});
