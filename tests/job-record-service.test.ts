import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
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
) {
  const attempts = new DeliveryAttemptRpc(
    jobs,
    deliveryJobs,
    new InMemoryRollbackFeatureFlag(rollbackAccounts),
  );
  return {
    service: new JobRecordService(jobs, attempts),
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
