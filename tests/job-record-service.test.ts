import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { InMemoryDeliveryRollbackFlag } from "../src/infrastructure/flags/in-memory-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { STUCK_ATTEMPT_THRESHOLD_MS } from "../src/domain/delivery-display-status";
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

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("with the rollback flag on, mutates the same row across retries and overwrites terminal execution details", async () => {
    const repo = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const service = new JobRecordService(
      repo,
      new DeliveryAttemptRpc(repo, attempts, new InMemoryDeliveryRollbackFlag([baseInput.accountId])),
    );

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
    expect(await attempts.listByJob(job.id)).toEqual([]);
  });

  test("keeps one attempt row per execution across a retry", async () => {
    const repo = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const service = new JobRecordService(
      repo,
      new DeliveryAttemptRpc(repo, attempts, new InMemoryDeliveryRollbackFlag()),
    );

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    const history = await attempts.listByJob(job.id);
    expect(history.map((a) => [a.attemptNumber, a.status, a.workerId])).toEqual([
      [1, "failed", "worker-us-east-04"],
      [2, "running", "worker-us-east-07"],
    ]);
    expect(history[0]?.errorBody).toBe("endpoint timeout after 30s");
    expect(final.status).toBe("running");
    expect(final.retryCount).toBe(1);
    expect((await repo.findById(job.id))?.status).toBe("queued");
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

function displaySetup(rolledBackAccountIds: string[] = []) {
  const repo = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const clock = { now: new Date() };
  const service = new JobRecordService(
    repo,
    new DeliveryAttemptRpc(repo, attempts, new InMemoryDeliveryRollbackFlag(rolledBackAccountIds)),
    () => clock.now,
  );
  return { repo, attempts, clock, service };
}

describe("JobRecordService display status", () => {
  test("is queued when the job has no attempts", async () => {
    const { service } = displaySetup();
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
    expect(await service.canStartNewDelivery(job)).toBe(true);
  });

  test("follows the latest attempt, not earlier ones or jobs.status", async () => {
    const { repo, service } = displaySetup();
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-us-east-07");
    await service.markCompleted(job.id, { responseStatus: 200 });

    const stored = await repo.findById(job.id);
    expect(stored?.status).toBe("queued");
    expect(await service.displayStatus(job)).toBe("completed");

    await service.markRunning(job.id, "worker-us-east-09");
    expect(await service.displayStatus(job)).toBe("running");
  });

  test("marks a running attempt stuck only once it is more than 5 minutes old", async () => {
    const { attempts, clock, service } = displaySetup();
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    const [attempt] = await attempts.listByJob(job.id);
    const startedAt = attempt?.startedAt.getTime() ?? 0;

    clock.now = new Date(startedAt + STUCK_ATTEMPT_THRESHOLD_MS);
    expect(await service.displayStatus(job)).toBe("running");
    expect(await service.canStartNewDelivery(job)).toBe(false);

    clock.now = new Date(startedAt + STUCK_ATTEMPT_THRESHOLD_MS + 1);
    expect(await service.displayStatus(job)).toBe("stuck");
    expect(await service.canStartNewDelivery(job)).toBe(true);
  });

  test("never marks a terminal attempt stuck", async () => {
    const { clock, service } = displaySetup();
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");

    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    expect(await service.displayStatus(job)).toBe("failed");
  });

  test("falls back to jobs.status when the rollback flag is on", async () => {
    const { attempts, clock, service } = displaySetup([baseInput.accountId]);
    const job = await service.ensureJobRecord(baseInput);
    const running = await service.markRunning(job.id, "worker-us-east-04");

    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    expect(await attempts.listByJob(job.id)).toEqual([]);
    expect(await service.displayStatus(running)).toBe("running");
    expect(await service.canStartNewDelivery(running)).toBe(false);
  });

  test("lists brief jobs with the derived status and otherwise unchanged fields", async () => {
    const { repo, service } = displaySetup();
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");

    const [listed] = await service.listByBrief(baseInput.briefId);
    const stored = await repo.findById(job.id);
    if (!stored) throw new Error("expected the stored job row");

    expect(listed).toEqual({ ...stored, status: "running" });
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
