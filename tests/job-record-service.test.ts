import { describe, expect, test } from "bun:test";
import {
  JobRecordService,
  STUCK_ATTEMPT_AFTER_MS,
} from "../src/application/job-record-service";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import {
  DELIVERY_ATTEMPTS_ROLLBACK_FLAG,
  StaticFeatureFlagStore,
} from "../src/application/feature-flags";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobRepository } from "../src/domain/job-repository";
import type {
  CreateDeliveryAttemptInput,
  CreateJobInput,
  DeliveryAttempt,
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

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("preserves earlier attempt history when a later attempt starts", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();

    const attempts = await repo.listAttempts(job.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "running",
      "queued",
      "failed",
      "running",
    ]);
    expect(attempts.some((attempt) => attempt.errorBody === "endpoint timeout after 30s")).toBe(true);
  });

  test("derives display status from the latest attempt and marks stale running attempts stuck", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");

    await service.markRunning(job.id, "worker-us-east-04");
    expect(await service.displayStatus(job)).toBe("running");

    const running = (await repo.listAttempts(job.id))[0];
    expect(running).toBeDefined();
    await repo.insertAttempt({
      deliveryJobId: job.id,
      attemptNumber: (running?.attemptNumber ?? 0) + 1,
      status: "running",
      workerId: "worker-us-east-04",
      startedAt: new Date(Date.now() - STUCK_ATTEMPT_AFTER_MS - 1),
    });

    expect(await service.displayStatus(job)).toBe("stuck");
    expect(await service.canStartNewDelivery(job)).toBe(true);
  });

  test("falls back to jobs.status when the rollback feature flag is on", async () => {
    const repo = new InMemoryJobRepository();
    const rpc = new DeliveryAttemptRpc(
      repo,
      new StaticFeatureFlagStore(new Set([DELIVERY_ATTEMPTS_ROLLBACK_FLAG])),
    );
    const service = new JobRecordService(repo, rpc);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    const updated = await repo.findById(job.id);
    expect(updated).not.toBeNull();
    expect(await repo.listAttempts(job.id)).toEqual([]);
    expect(await service.displayStatus(updated!)).toBe("running");
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const service = new JobRecordService(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
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

  async insertAttempt(_input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    throw new Error("not implemented");
  }

  async listAttempts(_deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [];
  }
}
