import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { JobNotFoundError } from "../src/domain/errors";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryAccountRetryBudget } from "../src/infrastructure/in-memory-account-retry-budget";
import { InMemoryRollbackFeatureFlag } from "../src/infrastructure/in-memory-rollback-feature-flag";
import { InMemoryDeliveryJobRepository } from "../src/infrastructure/repositories/in-memory-delivery-job-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

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

function createStack(rollbackAccounts: readonly string[] = []) {
  const jobs = new InMemoryJobRepository();
  const deliveryJobs = new InMemoryDeliveryJobRepository();
  const rollbackFlag = new InMemoryRollbackFeatureFlag(rollbackAccounts);
  const rpc = new DeliveryAttemptRpc(jobs, deliveryJobs, rollbackFlag);
  return {
    jobs,
    deliveryJobs,
    rollbackFlag,
    rpc,
    service: new JobRecordService(
      jobs,
      rpc,
      deliveryJobs,
      rollbackFlag,
      new InMemoryAccountRetryBudget(),
    ),
  };
}

describe("DeliveryAttemptRpc", () => {
  test("assigns monotonically increasing attempt numbers to racing callers", async () => {
    const { service, deliveryJobs } = createStack();
    const job = await service.ensureJobRecord(baseInput);

    await Promise.all([
      service.markRunning(job.id, "worker-a"),
      service.markRunning(job.id, "worker-b"),
      service.markFailed(job.id, "transient 503"),
    ]);

    const deliveryJob = await deliveryJobs.findByAccountBriefAndType(
      baseInput.accountId,
      baseInput.briefId,
      baseInput.type,
    );
    const history = await deliveryJobs.listAttempts(deliveryJob!.id);
    const numbers = history.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b);

    expect(numbers).toEqual([1, 2, 3]);
    expect(new Set(numbers).size).toBe(3);
  });

  test("mutates the jobs row and writes no attempts when the rollback flag is on", async () => {
    const { service, jobs, deliveryJobs } = createStack([baseInput.accountId]);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();
    expect(await jobs.findById(job.id)).toEqual(final);

    const deliveryJob = await deliveryJobs.findByAccountBriefAndType(
      baseInput.accountId,
      baseInput.briefId,
      baseInput.type,
    );
    expect(deliveryJob).toBeNull();
  });

  test("rejects execution writes when the job does not exist", async () => {
    const { rpc } = createStack();

    await expect(rpc.markRunning("missing", "worker-a")).rejects.toBeInstanceOf(JobNotFoundError);
    await expect(rpc.retry("missing")).rejects.toBeInstanceOf(JobNotFoundError);
  });
});
