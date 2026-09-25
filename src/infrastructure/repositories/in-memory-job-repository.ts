import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, DeliveryAttemptRecord[]>();

  async findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId && job.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const now = new Date();
    const job: JobRecord = {
      id: randomUUID(),
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

    this.jobs.set(job.id, job);
    return job;
  }

  async ensureDlqEntry(
    input: CreateJobInput & { type: "drain_dlq"; parentJobId: string },
  ): Promise<JobRecord> {
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.type === "drain_dlq" &&
        job.parentJobId === input.parentJobId &&
        job.accountId === input.accountId,
    );
    return existing ?? this.create(input);
  }

  async updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const now = new Date();
    const updated: JobRecord = {
      ...job,
      status: input.status,
      workerId: input.workerId ?? job.workerId,
      errorMessage: input.errorMessage,
      updatedAt: now,
      startedAt: input.status === "running" ? now : job.startedAt,
      completedAt:
        input.status === "completed" || input.status === "failed" || input.status === "cancelled"
          ? now
          : job.completedAt,
    };

    this.jobs.set(jobId, updated);
    return updated;
  }

  async incrementRetry(jobId: string): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const updated: JobRecord = {
      ...job,
      retryCount: job.retryCount + 1,
      updatedAt: new Date(),
    };

    this.jobs.set(jobId, updated);
    return updated;
  }

  async appendAttempt(
    jobId: string,
    attempt: Omit<DeliveryAttemptRecord, "jobId" | "attemptNumber" | "createdAt">,
  ): Promise<DeliveryAttemptRecord> {
    if (!this.jobs.has(jobId)) {
      throw new JobNotFoundError(jobId);
    }

    const existing = this.attempts.get(jobId) ?? [];
    const record: DeliveryAttemptRecord = {
      ...attempt,
      jobId,
      attemptNumber: existing.length + 1,
      createdAt: new Date(),
    };
    this.attempts.set(jobId, [...existing, record]);
    return record;
  }

  async listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]> {
    return [...(this.attempts.get(jobId) ?? [])];
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}
