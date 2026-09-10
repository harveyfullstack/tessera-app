import { randomUUID } from "crypto";
import { DuplicateAttemptError, DuplicateIntentError, JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateDeliveryAttemptInput,
  CreateJobInput,
  DeliveryAttempt,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, DeliveryAttempt>();

  async findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId && job.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const duplicate = [...this.jobs.values()].find(
      (job) =>
        job.accountId === input.accountId &&
        job.briefId === input.briefId &&
        job.type === input.type,
    );
    if (duplicate) {
      throw new DuplicateIntentError(input.accountId, input.briefId, input.type);
    }

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

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async insertAttempt(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    if (!this.jobs.has(input.deliveryJobId)) {
      throw new JobNotFoundError(input.deliveryJobId);
    }

    const duplicate = [...this.attempts.values()].find(
      (attempt) =>
        attempt.deliveryJobId === input.deliveryJobId &&
        attempt.attemptNumber === input.attemptNumber,
    );
    if (duplicate) {
      throw new DuplicateAttemptError(input.deliveryJobId, input.attemptNumber);
    }

    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt,
      createdAt: new Date(),
    };

    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.deliveryJobId === deliveryJobId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
  }

  async markDeadLettered(jobId: string): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const updated: JobRecord = {
      ...job,
      deadLetteredAt: job.deadLetteredAt ?? new Date(),
      updatedAt: new Date(),
    };

    this.jobs.set(jobId, updated);
    return updated;
  }
}
