import { describe, expect, test } from "bun:test";
import { JobRecordService, STUCK_AFTER_MS } from "../src/application/job-record-service";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliverySplitFlags } from "../src/application/delivery-split-flags";
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

function legacyService(repo: JobRepository): JobRecordService {
  const rpc = new DeliveryAttemptRpc(
    repo,
    new InMemoryDeliveryAttemptRepository(),
    new DeliverySplitFlags(),
  );
  return new JobRecordService(repo, rpc);
}

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = legacyService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("mutates the same row across retries and overwrites terminal execution details", async () => {
    const repo = new InMemoryJobRepository();
    const service = legacyService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    // Mutable row keeps no attempt history. The earlier timeout error
    // is cleared when the next attempt starts.
    expect(final.errorMessage).toBeUndefined();
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const service = legacyService(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });
});

describe("JobRecordService.displayStatus", () => {
  function splitService(flags: DeliverySplitFlags): {
    service: JobRecordService;
    attempts: InMemoryDeliveryAttemptRepository;
  } {
    const repo = new InMemoryJobRepository();
    const attempts = new InMemoryDeliveryAttemptRepository();
    const rpc = new DeliveryAttemptRpc(repo, attempts, flags);
    return { service: new JobRecordService(repo, rpc), attempts };
  }

  const pilotFlags = new DeliverySplitFlags({
    pilotAccountIds: [baseInput.accountId],
    rollbackAccountIds: [],
  });

  test("returns jobs.status (queued) for a new job with no attempt rows", async () => {
    const { service } = splitService(pilotFlags);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus(job)).toBe("queued");
  });

  test("returns the latest attempt's status for a pilot account", async () => {
    const { service } = splitService(pilotFlags);
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const failedThenQueued = await service.markFailed(job.id, "endpoint returned 503");

    // jobs.status and the latest attempt agree here; drift jobs.status to prove the attempt wins.
    expect(await service.displayStatus({ ...failedThenQueued, status: "completed" })).toBe(
      "failed",
    );
  });

  test("returns stuck when the latest attempt has been running more than 5 minutes", async () => {
    const { service } = splitService(pilotFlags);
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");

    const later = new Date(Date.now() + STUCK_AFTER_MS + 1_000);
    expect(await service.displayStatus(job, later)).toBe("stuck");
    expect(await service.displayStatus(job)).toBe("running");
  });

  test("falls back to jobs.status for a pre-cutover job with no attempt history", async () => {
    const { service } = splitService(pilotFlags);
    const job = await service.ensureJobRecord(baseInput);

    expect(await service.displayStatus({ ...job, status: "completed" })).toBe("completed");
  });

  test("falls back to jobs.status when the account is not a pilot account", async () => {
    const { service } = splitService(new DeliverySplitFlags());
    const job = await service.ensureJobRecord(baseInput);
    await service.markRunning(job.id, "worker-us-east-04");

    const later = new Date(Date.now() + STUCK_AFTER_MS + 1_000);
    expect(await service.displayStatus({ ...job, status: "failed" }, later)).toBe("failed");
  });

  test("falls back to jobs.status when the account's rollback flag is on", async () => {
    const pilot = splitService(pilotFlags);
    const job = await pilot.service.ensureJobRecord(baseInput);
    await pilot.service.markRunning(job.id, "worker-us-east-04");

    const rolledBack = new JobRecordService(
      new InMemoryJobRepository(),
      new DeliveryAttemptRpc(
        new InMemoryJobRepository(),
        pilot.attempts,
        new DeliverySplitFlags({
          pilotAccountIds: [baseInput.accountId],
          rollbackAccountIds: [baseInput.accountId],
        }),
      ),
    );

    expect(await rolledBack.displayStatus({ ...job, status: "failed" })).toBe("failed");
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
