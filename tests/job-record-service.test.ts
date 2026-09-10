import { describe, expect, test } from "bun:test";
import { createDeliveryRuntime } from "../src/application/delivery-runtime";
import { InMemoryDeliverySplitFlags } from "../src/application/delivery-split-flags";
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
    const { jobRecords } = createDeliveryRuntime();

    const first = await jobRecords.ensureJobRecord(baseInput);
    const second = await jobRecords.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("appends delivery_attempts through the RPC and preserves prior error bodies", async () => {
    const { jobRecords, deliveryAttempts } = createDeliveryRuntime();
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    await jobRecords.markFailed(job.id, "endpoint timeout after 30s", {
      errorBody: "endpoint timeout after 30s",
    });
    await jobRecords.retry(job.id);
    const final = await jobRecords.markRunning(job.id, "worker-us-east-07");

    const history = await deliveryAttempts.listByDeliveryJobId(job.id);
    expect(history.map((row) => row.status)).toEqual(["running", "failed", "queued", "running"]);
    expect(history[1]?.errorBody).toBe("endpoint timeout after 30s");
    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.status).toBe("running");
  });

  test("can produce duplicate intent rows under race conditions on the jobs table", async () => {
    const repo = new RacyJobRepository();
    const { jobRecords } = createDeliveryRuntime({ jobs: repo });

    const [a, b] = await Promise.all([
      jobRecords.ensureJobRecord(baseInput),
      jobRecords.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });

  test("derives display status from MAX(attempt_number) and marks stale running attempts stuck", async () => {
    const { jobRecords, deliveryAttempts } = createDeliveryRuntime();
    const job = await jobRecords.ensureJobRecord(baseInput);

    expect(await jobRecords.displayStatus(job)).toBe("queued");

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    const latest = await deliveryAttempts.findLatestByDeliveryJobId(job.id);
    expect(latest?.attemptNumber).toBe(1);
    expect(await jobRecords.displayStatus(job)).toBe("running");

    const sixMinutesLater = new Date((latest?.startedAt ?? new Date()).getTime() + 6 * 60 * 1000);
    expect(await jobRecords.displayStatus(job, sixMinutesLater)).toBe("stuck");
    expect(await jobRecords.canStartNewDelivery(job, sixMinutesLater)).toBe(true);

    await jobRecords.markFailed(job.id, "endpoint timeout after 30s");
    expect(await jobRecords.displayStatus(job, sixMinutesLater)).toBe("failed");
  });

  test("falls back to jobs.status for displayStatus when rollback is enabled", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    const { jobRecords, deliveryAttempts } = createDeliveryRuntime({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    expect(await deliveryAttempts.listByDeliveryJobId(job.id)).toHaveLength(1);
    expect(await jobRecords.displayStatus(job)).toBe("running");

    flags.enableRollback(baseInput.accountId);
    expect(await jobRecords.displayStatus(job)).toBe("queued");
  });

  test("falls back to mutating jobs when the rollback feature flag is on", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    flags.enableRollback(baseInput.accountId);
    const { jobRecords, deliveryAttempts } = createDeliveryRuntime({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    await jobRecords.markFailed(job.id, "endpoint timeout after 30s");
    await jobRecords.retry(job.id);
    const final = await jobRecords.markRunning(job.id, "worker-us-east-07");

    expect(await deliveryAttempts.listAll()).toHaveLength(0);
    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();
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
