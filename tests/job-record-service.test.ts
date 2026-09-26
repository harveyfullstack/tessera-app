import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobRepository } from "../src/domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  DlqSummary,
  JobListOptions,
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

  test("keeps latest execution details across retries", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.latestAttempt?.workerId).toBe("worker-us-east-07");
    expect(final.latestAttempt?.attemptNumber).toBe(3);
  });

  test("stores terminal execution details on the latest delivery attempt", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const job = await service.ensureJobRecord(baseInput);

    const completed = await service.markCompleted(job.id, {
      workerId: "worker-us-east-04",
      attemptNumber: 1,
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    expect(completed.latestAttempt?.deliveryJobId).toBe(job.id);
    expect(completed.latestAttempt?.responseStatus).toBe(200);
    expect(completed.latestAttempt?.responseLatencyMs).toBe(187);
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

  async appendAttempt(jobId: string, input: UpdateJobExecutionInput): Promise<DeliveryAttempt> {
    const existing = await this.findById(jobId);
    if (!existing) {
      throw new Error("not found");
    }

    return {
      id: crypto.randomUUID(),
      deliveryJobId: jobId,
      attemptNumber: input.details?.attemptNumber ?? 1,
      workerId: input.workerId ?? input.details?.workerId,
      status: input.status,
      responseStatus: input.details?.responseStatus,
      responseLatencyMs: input.details?.responseLatencyMs,
      errorBody: input.details?.errorBody ?? input.errorMessage,
      createdAt: new Date(),
    };
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

  async listByBrief(briefId: string, _options: JobListOptions = {}): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.briefId === briefId);
  }

  async getDlqSummary(_briefId: string): Promise<DlqSummary> {
    return { count: 0, lastAttemptBodies: [] };
  }
}
