import { describe, expect, test } from "bun:test";
import { InMemoryAccountRetryBudget } from "../src/application/account-retry-budget";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "../src/application/delivery-attempt-rollback-flags";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
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

function createService(rollback = false) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
  const retryBudgets = new InMemoryAccountRetryBudget();
  const attemptRpc = new DeliveryAttemptRpc(jobs, attempts, rollbackFlags);
  const service = new JobRecordService(jobs, attemptRpc, rollbackFlags, retryBudgets);

  if (rollback) {
    rollbackFlags.enable("acct-1");
  }

  return { service, attempts, jobs };
}

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const { service } = createService();

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("appends attempt rows instead of overwriting execution history", async () => {
    const { service, attempts } = createService();

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-us-east-07");

    const history = await attempts.listByJobId(job.id);
    expect(history.length).toBe(4);
    expect(history[0]?.workerId).toBe("worker-us-east-07");
    const failedAttempt = history.find((attempt) => attempt.status === "failed");
    expect(failedAttempt?.errorBody).toBe("endpoint timeout after 30s");
  });

  test("skips attempt inserts when the rollback feature flag is on", async () => {
    const { service, attempts } = createService(true);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "legacy failure");

    expect(await attempts.countByJobId(job.id)).toBe(0);
    const updated = await service.listByBrief(job.briefId);
    expect(updated[0]?.status).toBe("failed");
    expect(updated[0]?.errorMessage).toBe("legacy failure");
  });

  test("deduplicates intent rows under race conditions", async () => {
    const jobs = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
    const retryBudgets = new InMemoryAccountRetryBudget();
    const service = new JobRecordService(
      jobs,
      new DeliveryAttemptRpc(jobs, attempts, rollbackFlags),
      rollbackFlags,
      retryBudgets,
    );
    const repo = new RacyJobRepository();
    const racyService = new JobRecordService(
      repo,
      new DeliveryAttemptRpc(repo, attempts, rollbackFlags),
      rollbackFlags,
      retryBudgets,
    );

    const [a, b] = await Promise.all([
      racyService.ensureJobRecord(baseInput),
      racyService.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);

    const [canonicalA, canonicalB] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);
    expect(canonicalA.id).toBe(canonicalB.id);
  });

  test("derives queued display status when no attempts exist", async () => {
    const { service } = createService();
    const job = await service.ensureJobRecord(baseInput);
    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("derives stuck display status from stale running attempts", async () => {
    const { service, attempts } = createService();
    const job = await service.ensureJobRecord(baseInput);

    const staleStart = new Date(Date.now() - 6 * 60 * 1000);
    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "running",
      startedAt: staleStart,
    });

    expect(await service.displayStatus(job)).toBe("stuck");
  });

  test("falls back to jobs.status when rollback flag is enabled", async () => {
    const { service } = createService(true);
    const job = await service.ensureJobRecord(baseInput);
    const failed = await service.markFailed(job.id, "legacy failure");

    expect(await service.displayStatus(failed)).toBe("failed");
  });
});

class RacyJobRepository implements JobRepository {
  private jobs = new Map<string, JobRecord>();
  created: JobRecord[] = [];

  async findByBriefAndType(_briefId: string, _type: JobType): Promise<JobRecord[]> {
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
