import { describe, expect, test } from "bun:test";
import { JobRecordService } from "../src/application/job-record-service";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import {
  deriveDisplayStatus,
  STUCK_RUN_THRESHOLD_MS,
} from "../src/application/delivery-display-status";
import type { DeliveryAttempt } from "../src/domain/delivery-attempt";
import { StaticDeliveryRollbackFlag } from "../src/infrastructure/flags/static-delivery-rollback-flag";
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

function serviceFor(
  repo: JobRepository,
  closedRollbackAccounts: string[] = [],
  now: () => Date = () => new Date(),
): JobRecordService {
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(
    repo,
    attempts,
    new StaticDeliveryRollbackFlag(closedRollbackAccounts),
  );
  return new JobRecordService(repo, rpc, attempts, now);
}

function attempt(
  attemptNumber: number,
  status: DeliveryAttempt["status"],
  startedAt?: Date,
): DeliveryAttempt {
  return {
    id: `attempt-${attemptNumber}`,
    deliveryJobId: "job-1",
    attemptNumber,
    status,
    startedAt,
    backfilled: false,
    createdAt: startedAt ?? new Date("2026-01-01T10:00:00Z"),
  };
}

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("mutates the same row across retries and overwrites terminal execution details", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo);

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
    const service = serviceFor(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });
});

describe("JobRecordService.displayStatus", () => {
  const closed = [baseInput.accountId];

  test("is queued when the job has no attempts", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo, closed);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("derives the latest run's status instead of the stale jobs.status", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo, closed);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markCompleted(job.id, { workerId: "worker-us-east-04" });
    const stale = await repo.findById(job.id);

    expect(stale?.status).toBe("queued");
    expect(await service.displayStatus(job)).toBe("completed");
  });

  test("keeps showing the failed run when a retry is queued after it", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo, closed);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);

    expect(await service.displayStatus(job)).toBe("failed");
  });

  test("is stuck once a running attempt is more than 5 minutes old", async () => {
    let now = new Date();
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo, closed, () => now);
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");
    const startedAt = new Date();

    now = new Date(startedAt.getTime() - 1000 + STUCK_RUN_THRESHOLD_MS);
    expect(await service.displayStatus(job)).toBe("running");
    expect(await service.canStartNewDelivery(job)).toBe(false);

    now = new Date(startedAt.getTime() + STUCK_RUN_THRESHOLD_MS + 1000);
    expect(await service.displayStatus(job)).toBe("stuck");
    expect(await service.canStartNewDelivery(job)).toBe(false);
  });

  test("falls back to jobs.status while the rollback window is open", async () => {
    const repo = new InMemoryJobRepository();
    const service = serviceFor(repo, [], () => new Date(Date.now() + 2 * STUCK_RUN_THRESHOLD_MS));
    const job = await service.ensureJobRecord(baseInput);
    const running = await service.markRunning(job.id, "worker-us-east-04");

    expect(await service.displayStatus(running)).toBe("running");
  });
});

describe("deriveDisplayStatus", () => {
  const startedAt = new Date("2026-01-01T10:00:00Z");
  const at = (ms: number) => new Date(startedAt.getTime() + ms);

  test("treats a job with only a queued retry as queued", () => {
    expect(deriveDisplayStatus([attempt(1, "queued")], startedAt)).toBe("queued");
  });

  test("reads the highest-numbered run regardless of row order", () => {
    const attempts = [attempt(4, "completed", startedAt), attempt(1, "running", startedAt)];
    expect(deriveDisplayStatus(attempts, startedAt)).toBe("completed");
  });

  test("is not stuck at exactly the threshold", () => {
    const attempts = [attempt(1, "running", startedAt)];
    expect(deriveDisplayStatus(attempts, at(STUCK_RUN_THRESHOLD_MS))).toBe("running");
    expect(deriveDisplayStatus(attempts, at(STUCK_RUN_THRESHOLD_MS + 1))).toBe("stuck");
  });

  test("never marks a running attempt without started_at as stuck", () => {
    expect(deriveDisplayStatus([attempt(1, "running")], at(STUCK_RUN_THRESHOLD_MS * 10))).toBe(
      "running",
    );
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
