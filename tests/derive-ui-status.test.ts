import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

const testInput: CreateJobInput = {
  accountId: "acct-ui-status",
  briefId: "7f000002-0000-4000-a000-00000000000c",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_ui",
    subscriptionId: "sub_ui",
    endpointUrl: "https://hooks.ui.test/webhook",
    eventType: "user.signup",
    payloadHash: "sha256:456",
  },
};

describe("TESSERA-1882: derive UI status from latest delivery attempt", () => {
  test("returns queued when the job has no attempts", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(testInput);

    const status = await service.displayStatus(job);
    expect(status).toBe("queued");
  });

  test("derives status from MAX(attempt_number)", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(testInput);

    await service.markRunning(job.id, "worker-1");
    expect(await service.displayStatus(job)).toBe("running");

    await service.markFailed(job.id, "503 service unavailable");
    expect(await service.displayStatus(job)).toBe("failed");

    await service.retry(job.id);
    expect(await service.displayStatus(job)).toBe("queued");

    await service.markRunning(job.id, "worker-2");
    await service.markCompleted(job.id, { responseStatus: 200 });
    expect(await service.displayStatus(job)).toBe("completed");
  });

  test("returns stuck when latest attempt is running and started_at is > 5 minutes old", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(testInput);

    const now = new Date();
    const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000);

    // Insert a running attempt that started 6 minutes ago
    await repo.createDeliveryJob({
      ...({ id: job.id } as unknown as CreateJobInput),
      accountId: job.accountId,
      briefId: job.briefId,
      type: job.type,
      metadata: job.metadata,
    });

    await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      workerId: "worker-stuck",
      status: "running",
      startedAt: sixMinutesAgo,
    });

    const status = await service.displayStatus(job, now);
    expect(status).toBe("stuck");
    expect(await service.canStartNewDelivery(job, now)).toBe(false);

    // If started only 2 minutes ago, it is running and not stuck
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    const freshJob = await service.ensureJobRecord({
      ...testInput,
      briefId: "fresh-brief",
    });
    await repo.createDeliveryJob({
      ...({ id: freshJob.id } as unknown as CreateJobInput),
      accountId: freshJob.accountId,
      briefId: freshJob.briefId,
      type: freshJob.type,
      metadata: freshJob.metadata,
    });
    await repo.createDeliveryAttempt({
      deliveryJobId: freshJob.id,
      attemptNumber: 1,
      workerId: "worker-fresh",
      status: "running",
      startedAt: twoMinutesAgo,
    });

    const freshStatus = await service.displayStatus(freshJob, now);
    expect(freshStatus).toBe("running");
  });

  test("falls back to jobs.status when the rollback feature flag is on", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const rpc = service.getRpc();
    const job = await service.ensureJobRecord(testInput);

    // Set a delivery attempt with "completed"
    await service.markRunning(job.id, "worker-1");
    await service.markCompleted(job.id, { responseStatus: 200 });

    // Legacy jobs row is "completed" as well, but let's change jobs.status to "cancelled"
    await repo.updateExecution(job.id, { status: "cancelled" });
    const updatedJob = (await repo.findById(job.id))!;

    // When rollback is off, it derives from latest attempt ("completed")
    expect(await service.displayStatus(updatedJob)).toBe("completed");

    // Turn rollback feature flag ON
    rpc.setRollbackFlagForAccount(job.accountId, true);
    // When rollback is ON, it falls back to jobs.status ("cancelled")
    expect(await service.displayStatus(updatedJob)).toBe("cancelled");
  });
});
