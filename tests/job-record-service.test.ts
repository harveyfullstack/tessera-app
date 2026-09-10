import { describe, expect, test } from "bun:test";
import { createJobServiceGraph } from "../src/application/job-service-factory";
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
    const { jobRecords } = createJobServiceGraph();

    const first = await jobRecords.ensureJobRecord(baseInput);
    const second = await jobRecords.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("appends a delivery attempt for each execution write and keeps prior errors", async () => {
    const { jobRecords, attempts } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    await jobRecords.markFailed(job.id, "endpoint timeout after 30s");
    await jobRecords.retry(job.id);
    const final = await jobRecords.markRunning(job.id, "worker-us-east-07");

    const history = await attempts.listByDeliveryJobId(job.id);
    expect(history.map((row) => row.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(history.some((row) => row.errorBody === "endpoint timeout after 30s")).toBe(true);
    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const { jobRecords } = createJobServiceGraph({ jobs: repo });

    const [a, b] = await Promise.all([
      jobRecords.ensureJobRecord(baseInput),
      jobRecords.ensureJobRecord(baseInput),
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
