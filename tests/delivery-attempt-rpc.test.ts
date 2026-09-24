import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { AccountRollbackFlags } from "../src/domain/delivery-rollback";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput, JobExecutionDetails } from "../src/domain/job";

const input: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-1",
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
  test("appends one attempt per execution write and ignores caller attempt numbers", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const service = new JobRecordService(jobs, attempts, new AccountRollbackFlags(new Set()));
    const job = await service.ensureJobRecord(input);
    const callerDetails: JobExecutionDetails = {
      attemptNumber: 99,
      workerId: "worker-a",
      responseStatus: 503,
      responseLatencyMs: 1200,
      errorBody: "timeout",
    };

    await service.markRunning(job.id, "worker-a");
    await service.retry(job.id);
    await service.markFailed(job.id, "timeout", callerDetails);
    const completed = await service.markCompleted(job.id, {
      workerId: "worker-b",
      responseStatus: 200,
      responseLatencyMs: 40,
    });

    const rows = await attempts.list(job.id);
    expect(rows.map((row) => row.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.status)).toEqual(["running", "queued", "failed", "completed"]);
    expect(rows[2]).toMatchObject({
      responseStatus: 503,
      responseLatencyMs: 1200,
      errorBody: "timeout",
    });
    expect(rows.every((row) => row.attemptNumber !== 99)).toBe(true);
    expect(completed.status).toBe("completed");
    expect(completed.retryCount).toBe(1);
  });

  test("assigns monotonic attempt numbers to racing callers", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const rpc = new DeliveryAttemptRpc(jobs, attempts, new AccountRollbackFlags(new Set()));
    const job = await jobs.create(input);

    await Promise.all([
      rpc.markRunning(job, "worker-a"),
      rpc.markRunning(job, "worker-b"),
      rpc.markFailed(job, "late failure"),
    ]);

    const rows = await attempts.list(job.id);
    expect(rows.map((row) => row.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((row) => row.attemptNumber)).size).toBe(3);
  });

  test("rollback flag skips attempt inserts and still updates the legacy row", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const flags = new AccountRollbackFlags(new Set(["acct-1"]));
    let checks = 0;
    const service = new JobRecordService(jobs, attempts, {
      isRollbackEnabled(accountId: string): boolean {
        checks += 1;
        return flags.isRollbackEnabled(accountId);
      },
    });
    const job = await service.ensureJobRecord(input);

    const running = await service.markRunning(job.id, "worker-a");
    const retried = await service.retry(job.id);
    const failed = await service.markFailed(job.id, "timeout", { errorBody: "timeout" });
    const completed = await service.markCompleted(job.id, { workerId: "worker-a", responseStatus: 200 });

    expect(running.status).toBe("running");
    expect(running.workerId).toBe("worker-a");
    expect(retried.retryCount).toBe(1);
    expect(failed.status).toBe("failed");
    expect(completed.status).toBe("completed");
    expect(await attempts.list(job.id)).toEqual([]);
    expect(checks).toBe(4);
  });
});
