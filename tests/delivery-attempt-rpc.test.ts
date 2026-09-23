import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobRecordService } from "../src/application/job-record-service";
import { JobNotFoundError } from "../src/domain/errors";
import type { JobRecord } from "../src/domain/job";
import { StaticDeliveryRollbackFlag } from "../src/infrastructure/flags/static-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const accountId = "acct-1";

const baseRequest = {
  accountId,
  briefId: "50ce0002-0000-4000-a001-000000000001",
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-us-east-04",
} as const;

function setup(closedAccountIds: string[] = []) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(
    jobs,
    attempts,
    new StaticDeliveryRollbackFlag(closedAccountIds),
  );
  const service = new JobRecordService(jobs, rpc);
  const orchestrator = new DeliveryOrchestrator(service);
  return { jobs, attempts, rpc, orchestrator };
}

async function createJob(jobs: InMemoryJobRepository): Promise<JobRecord> {
  return jobs.create({
    accountId,
    briefId: baseRequest.briefId,
    type: "dispatch_webhook",
    metadata: {
      customerId: baseRequest.customerId,
      subscriptionId: baseRequest.subscriptionId,
      endpointUrl: baseRequest.endpointUrl,
      eventType: baseRequest.eventType,
      payloadHash: baseRequest.payloadHash,
    },
  });
}

// Same formula as delivery_jobs_legacy_attempt_count in migration 002.
function legacyAttemptCount(job: JobRecord): number {
  if (!job.startedAt) {
    return 0;
  }
  if (job.status === "failed") {
    return Math.max(job.retryCount, 1);
  }
  return job.retryCount + 1;
}

describe("DeliveryAttemptRpc", () => {
  test("appends one attempt row per call with increasing attempt numbers", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await createJob(jobs);

    await rpc.markRunning(job.id, "w-1");
    await rpc.retry(job.id);
    await rpc.markFailed(job.id, "timeout", { workerId: "w-1", responseStatus: 503 });
    await rpc.markRunning(job.id, "w-2");
    await rpc.markCompleted(job.id, { workerId: "w-2", responseStatus: 200 });

    const history = await attempts.listByJob(job.id);
    expect(history.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(history.map((a) => a.status)).toEqual([
      "running",
      "queued",
      "failed",
      "running",
      "completed",
    ]);
    expect(history.every((a) => !a.backfilled)).toBe(true);
  });

  test("gives racing callers unique, monotonically increasing attempt numbers", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await createJob(jobs);

    const writes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => rpc.markRunning(job.id, `w-${i}`)),
    );

    expect(writes.map((w) => w.attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await attempts.listByJob(job.id)).length).toBe(10);
  });

  test("terminal rows carry the startedAt of the run that opened them", async () => {
    const { jobs, rpc } = setup();
    const job = await createJob(jobs);

    const running = await rpc.markRunning(job.id, "w-1");
    const queued = await rpc.retry(job.id);
    const failed = await rpc.markFailed(job.id, "timeout");

    expect(running.attempt.startedAt).toBeInstanceOf(Date);
    expect(queued.attempt.startedAt).toBeUndefined();
    expect(failed.attempt.startedAt).toEqual(running.attempt.startedAt);
    expect(failed.attempt.errorBody).toBe("timeout");
  });

  test("dual-writes legacy columns while the rollback window is open", async () => {
    const { jobs, rpc } = setup();
    const job = await createJob(jobs);

    await rpc.markRunning(job.id, "w-1");
    const { job: afterRetry } = await rpc.retry(job.id);

    expect(afterRetry.status).toBe("running");
    expect(afterRetry.retryCount).toBe(1);
    expect(afterRetry.workerId).toBe("w-1");
  });

  test("stops writing legacy columns once the account's rollback window is closed", async () => {
    const { jobs, attempts, rpc } = setup([accountId]);
    const job = await createJob(jobs);

    await rpc.markRunning(job.id, "w-1");
    await rpc.retry(job.id);
    const { job: after } = await rpc.markFailed(job.id, "timeout");

    expect(after.status).toBe("queued");
    expect(after.retryCount).toBe(0);
    expect(after.startedAt).toBeUndefined();
    expect((await attempts.listByJob(job.id)).length).toBe(3);
  });

  test("rejects unknown jobs without appending an attempt", async () => {
    const { attempts, rpc } = setup();

    await expect(rpc.markRunning("missing-job", "w-1")).rejects.toBeInstanceOf(JobNotFoundError);
    expect(await attempts.listByJob("missing-job")).toEqual([]);
  });

  test("keeps old/new attempt-count parity across failed and completed runs", async () => {
    const { attempts, orchestrator } = setup();

    await orchestrator.deliver({ ...baseRequest, simulateFailure: true });
    const afterFailure = await orchestrator.deliver({ ...baseRequest, simulateFailure: true });
    const runningAfterFailures = (await attempts.listByJob(afterFailure.id)).filter(
      (a) => a.status === "running",
    );
    expect(afterFailure.status).toBe("failed");
    expect(runningAfterFailures.length).toBe(legacyAttemptCount(afterFailure));

    const completed = await orchestrator.deliver({ ...baseRequest, simulateFailure: false });
    const history = await attempts.listByJob(completed.id);
    const runs = history.filter((a) => a.status === "running").length;

    expect(completed.status).toBe("completed");
    expect(completed.retryCount).toBe(2);
    expect(runs).toBe(3);
    expect(runs).toBe(legacyAttemptCount(completed));
  });
});
