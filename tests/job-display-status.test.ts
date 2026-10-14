import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc, type DeliverySplitFlags } from "../src/application/delivery-attempt-rpc";
import {
  JobRecordService,
  STUCK_ATTEMPT_THRESHOLD_MS,
} from "../src/application/job-record-service";
import type { CreateJobInput, JobRecord } from "../src/domain/job";
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

function after(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function reload(jobs: InMemoryJobRepository, job: JobRecord): Promise<JobRecord> {
  const stored = await jobs.findById(job.id);
  if (!stored) {
    throw new Error(`job ${job.id} missing`);
  }
  return stored;
}

describe("JobRecordService.displayStatus", () => {
  test("returns the latest attempt status for a pilot account", async () => {
    const { jobs, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");

    expect(await service.displayStatus(await reload(jobs, job))).toBe("failed");
  });

  test("reports a running attempt as stuck only once it is more than 5 minutes old", async () => {
    const { jobs, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    const running = await reload(jobs, job);

    expect(await service.displayStatus(running)).toBe("running");
    expect(await service.displayStatus(running, after(STUCK_ATTEMPT_THRESHOLD_MS - 1_000))).toBe(
      "running",
    );
    expect(await service.displayStatus(running, after(STUCK_ATTEMPT_THRESHOLD_MS + 1_000))).toBe(
      "stuck",
    );
    expect(await service.canStartNewDelivery(running, after(STUCK_ATTEMPT_THRESHOLD_MS + 1_000))).toBe(
      false,
    );
  });

  test("never reports a finished attempt as stuck", async () => {
    const { jobs, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    await service.markCompleted(job.id, { workerId: "worker-us-east-04", responseStatus: 200 });

    const completed = await reload(jobs, job);
    expect(await service.displayStatus(completed, after(STUCK_ATTEMPT_THRESHOLD_MS * 10))).toBe(
      "completed",
    );
  });

  test("falls back to jobs.status when a pilot job has no attempt rows", async () => {
    const { jobs, service } = setup({ pilotAccountIds: new Set([pilotAccount]) });

    const fresh = await service.ensureJobRecord(baseInput);
    expect(fresh.deliveryJobId).toBeUndefined();
    expect(await service.displayStatus(fresh)).toBe("queued");

    // Pre-cutover job: status was written on the legacy path, no attempt bodies exist.
    const preCutover = await jobs.updateExecution(fresh.id, { status: "failed", errorMessage: "legacy" });
    expect(await service.displayStatus(preCutover, after(STUCK_ATTEMPT_THRESHOLD_MS * 10))).toBe(
      "failed",
    );
  });

  test("falls back to jobs.status for a non-pilot account", async () => {
    const { jobs, service } = setup();
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");

    const running = await reload(jobs, job);
    expect(running.deliveryJobId).toBeUndefined();
    expect(await service.displayStatus(running, after(STUCK_ATTEMPT_THRESHOLD_MS * 10))).toBe(
      "running",
    );
  });

  test("falls back to jobs.status when the rollback flag is on, even with attempt rows", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const pilot = new JobRecordService(
      jobs,
      new DeliveryAttemptRpc(jobs, attempts, {
        pilotAccountIds: new Set([pilotAccount]),
        rollbackAccountIds: new Set<string>(),
      }),
    );
    const job = await pilot.ensureJobRecord(baseInput);
    await pilot.markRunning(job.id, "worker-us-east-04");

    const rolledBack = new JobRecordService(
      jobs,
      new DeliveryAttemptRpc(jobs, attempts, {
        pilotAccountIds: new Set([pilotAccount]),
        rollbackAccountIds: new Set([pilotAccount]),
      }),
    );
    await rolledBack.markFailed(job.id, "endpoint timeout after 30s");

    const stored = await reload(jobs, job);
    expect(stored.deliveryJobId).toBeDefined();
    // The latest attempt row still says running; jobs.status is authoritative under rollback.
    expect(await pilot.displayStatus(stored, after(STUCK_ATTEMPT_THRESHOLD_MS * 10))).toBe("stuck");
    expect(await rolledBack.displayStatus(stored, after(STUCK_ATTEMPT_THRESHOLD_MS * 10))).toBe(
      "failed",
    );
  });
});
