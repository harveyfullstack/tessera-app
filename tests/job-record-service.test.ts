import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import {
  JobRecordService,
  STUCK_ATTEMPT_THRESHOLD_MS,
} from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptStore } from "../src/infrastructure/repositories/in-memory-delivery-attempt-store";
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
  repo: JobRepository,
  pilotAccountIds: ReadonlySet<string> = new Set<string>(),
  rollbackAccountIds: ReadonlySet<string> = new Set<string>(),
): JobRecordService {
  const attempts = new InMemoryDeliveryAttemptStore();
  return new JobRecordService(
    repo,
    new DeliveryAttemptRpc(repo, attempts, { pilotAccountIds, rollbackAccountIds }),
    attempts,
  );
}

function afterStuckThreshold(): Date {
  return new Date(Date.now() + STUCK_ATTEMPT_THRESHOLD_MS + 1000);
}

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("mutates the same row across retries and overwrites terminal execution details", async () => {
    const repo = new InMemoryJobRepository();
    const service = createService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    // Pre-migration pain: mutable row with no attempt history. The earlier
    // timeout error is gone the moment the next attempt starts.
    expect(final.errorMessage).toBeUndefined();
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const service = createService(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });
});

describe("JobRecordService.displayStatus", () => {
  const pilot = new Set([baseInput.accountId]);

  test("shows queued for a new job with no attempt rows", async () => {
    const service = createService(new InMemoryJobRepository(), pilot);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("reads the status of the latest attempt for pilot accounts", async () => {
    const service = createService(new InMemoryJobRepository(), pilot);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    const retried = await service.retry(job.id);

    expect(retried.status).toBe("failed");
    expect(await service.displayStatus(retried)).toBe("queued");
  });

  test("shows stuck when the latest running attempt started over 5 minutes ago", async () => {
    const service = createService(new InMemoryJobRepository(), pilot);
    const job = await service.ensureJobRecord(baseInput);
    const running = await service.markRunning(job.id, "worker-us-east-04");

    expect(await service.displayStatus(running)).toBe("running");
    expect(await service.displayStatus(running, afterStuckThreshold())).toBe("stuck");
    expect(await service.canStartNewDelivery(running)).toBe(false);
  });

  test("keeps jobs.status for a pre-cutover job with no attempt rows", async () => {
    const repo = new InMemoryJobRepository();
    const legacy = createService(repo);
    const job = await legacy.ensureJobRecord(baseInput);
    const completed = await legacy.markCompleted(job.id, { responseStatus: 200 });

    const service = createService(repo, pilot);
    expect(await service.displayStatus(completed)).toBe("completed");
  });

  test("falls back to jobs.status for non-pilot accounts", async () => {
    const service = createService(new InMemoryJobRepository());
    const job = await service.ensureJobRecord(baseInput);
    const running = await service.markRunning(job.id, "worker-us-east-04");

    expect(await service.displayStatus(running, afterStuckThreshold())).toBe("running");
  });

  test("falls back to jobs.status when the rollback flag is on", async () => {
    const repo = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptStore();
    const flags = { pilotAccountIds: pilot, rollbackAccountIds: new Set<string>() };
    const service = new JobRecordService(
      repo,
      new DeliveryAttemptRpc(repo, attempts, flags),
      attempts,
    );
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    const retried = await service.retry(job.id);

    const rolledBack = new JobRecordService(
      repo,
      new DeliveryAttemptRpc(repo, attempts, { ...flags, rollbackAccountIds: pilot }),
      attempts,
    );
    expect(await service.displayStatus(retried)).toBe("queued");
    expect(await rolledBack.displayStatus(retried)).toBe("running");
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

  async linkDeliveryJob(jobId: string, deliveryJobId: string): Promise<JobRecord> {
    const existing = await this.findById(jobId);
    if (!existing) {
      throw new Error("not found");
    }

    const updated: JobRecord = { ...existing, deliveryJobId };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.briefId === briefId);
  }
}
