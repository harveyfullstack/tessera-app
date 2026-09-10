import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryAccountRetryBudget } from "../src/infrastructure/in-memory-account-retry-budget";
import { InMemoryRollbackFeatureFlag } from "../src/infrastructure/in-memory-rollback-feature-flag";
import { InMemoryDeliveryJobRepository } from "../src/infrastructure/repositories/in-memory-delivery-job-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobRepository } from "../src/domain/job-repository";
import type {
  CreateJobInput,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../src/domain/job";

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

function createService(
  jobs: JobRepository = new InMemoryJobRepository(),
  deliveryJobs = new InMemoryDeliveryJobRepository(),
  rollbackAccounts: readonly string[] = [],
  now: () => Date = () => new Date(),
) {
  const rollbackFlag = new InMemoryRollbackFeatureFlag(rollbackAccounts);
  const attempts = new DeliveryAttemptRpc(jobs, deliveryJobs, rollbackFlag);
  return {
    service: new JobRecordService(
      jobs,
      attempts,
      deliveryJobs,
      rollbackFlag,
      new InMemoryAccountRetryBudget(),
      now,
    ),
    jobs,
    deliveryJobs,
  };
}

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const { service } = createService();

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("appends a delivery attempt per execution write and keeps prior history", async () => {
    const { service, deliveryJobs } = createService();

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    const deliveryJob = await deliveryJobs.findByAccountBriefAndType(
      baseInput.accountId,
      baseInput.briefId,
      baseInput.type,
    );
    const history = await deliveryJobs.listAttempts(deliveryJob!.id);

    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([4, 3, 2, 1]);
    expect(history.map((attempt) => attempt.status)).toEqual([
      "running",
      "queued",
      "failed",
      "running",
    ]);
    expect(history[2]?.errorBody).toBe("endpoint timeout after 30s");
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.retryCount).toBe(1);
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const { service } = createService(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });

  test("displayStatus is queued when the job has no delivery attempts", async () => {
    const { service } = createService();
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("displayStatus is queued when a delivery job exists but the attempt list is empty", async () => {
    const { service, deliveryJobs } = createService();
    const job = await service.ensureJobRecord(baseInput);
    await deliveryJobs.create(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("displayStatus reads the latest attempt by attempt_number", async () => {
    const { service } = createService();
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    expect(await service.displayStatus(job)).toBe("running");

    await service.markFailed(job.id, "endpoint timeout after 30s");
    expect(await service.displayStatus(job)).toBe("failed");

    await service.retry(job.id);
    expect(await service.displayStatus(job)).toBe("queued");

    const completed = await service.markCompleted(job.id, {
      workerId: "worker-us-east-07",
      responseStatus: 200,
      responseLatencyMs: 187,
    });
    expect(await service.displayStatus(completed)).toBe("completed");
  });

  test("displayStatus is stuck when the latest running attempt started more than 5 minutes ago", async () => {
    const now = new Date("2026-09-10T16:00:00.000Z");
    const { service, deliveryJobs } = createService(
      new InMemoryJobRepository(),
      new InMemoryDeliveryJobRepository(),
      [],
      () => now,
    );
    const job = await service.ensureJobRecord(baseInput);
    const deliveryJob = await deliveryJobs.create(baseInput);
    await deliveryJobs.appendAttempt({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      status: "failed",
      startedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });
    await deliveryJobs.appendAttempt({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 2,
      workerId: "worker-us-east-04",
      status: "running",
      startedAt: new Date(now.getTime() - 5 * 60 * 1000 - 1),
    });

    expect(await service.displayStatus(job)).toBe("stuck");
  });

  test("displayStatus stays running when started_at is exactly 5 minutes ago", async () => {
    const now = new Date("2026-09-10T16:00:00.000Z");
    const { service, deliveryJobs } = createService(
      new InMemoryJobRepository(),
      new InMemoryDeliveryJobRepository(),
      [],
      () => now,
    );
    const job = await service.ensureJobRecord(baseInput);
    const deliveryJob = await deliveryJobs.create(baseInput);
    await deliveryJobs.appendAttempt({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      workerId: "worker-us-east-04",
      status: "running",
      startedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });

    expect(await service.displayStatus(job)).toBe("running");
  });

  test("displayStatus falls back to jobs.status when the rollback flag is on", async () => {
    const now = new Date("2026-09-10T16:00:00.000Z");
    const jobs = new InMemoryJobRepository();
    const deliveryJobs = new InMemoryDeliveryJobRepository();
    const { service } = createService(jobs, deliveryJobs, [baseInput.accountId], () => now);
    const job = await service.ensureJobRecord(baseInput);
    const failed = await service.markFailed(job.id, "legacy row failure");
    const deliveryJob = await deliveryJobs.create(baseInput);
    await deliveryJobs.appendAttempt({
      deliveryJobId: deliveryJob.id,
      attemptNumber: 1,
      workerId: "worker-us-east-04",
      status: "running",
      startedAt: new Date(now.getTime() - 10 * 60 * 1000),
    });

    expect(failed.status).toBe("failed");
    expect(await service.displayStatus(failed)).toBe("failed");
  });
});

class RacyJobRepository implements JobRepository {
  private jobs = new Map<string, JobRecord>();
  created: JobRecord[] = [];

  async findByBriefAndType(_briefId: string, _type: JobType): Promise<JobRecord[]> {
    // Stale read window where concurrent callers both observe no row.
    return [];
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const now = new Date();
    const id = crypto.randomUUID();
    const record: JobRecord = {
      id,
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      parentJobId: input.parentJobId,
      type: input.type,
      metadata: input.metadata,
      status: "queued",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, record);
    this.created.push(record);
    return record;
  }

  async updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    const existing = await this.findById(jobId);
    if (!existing) {
      throw new Error("not found");
    }

    const updated: JobRecord = {
      ...existing,
      status: input.status,
      workerId: input.workerId,
      errorMessage: input.errorMessage,
      updatedAt: new Date(),
    };

    this.jobs.set(jobId, updated);
    return updated;
  }

  async incrementRetry(jobId: string): Promise<JobRecord> {
    const existing = await this.findById(jobId);
    if (!existing) {
      throw new Error("not found");
    }

    const updated: JobRecord = {
      ...existing,
      retryCount: existing.retryCount + 1,
      updatedAt: new Date(),
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.briefId === briefId);
  }
}
