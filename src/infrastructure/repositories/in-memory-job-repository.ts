import { randomUUID } from "crypto";
import type { CreateDeliveryAttemptInput, DeliveryAttempt } from "../../domain/delivery-attempt";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
  JobNotFoundError,
} from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  async findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId && job.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findByAccountBriefAndType(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<JobRecord | null> {
    return (
      [...this.jobs.values()].find(
        (job) => job.accountId === accountId && job.briefId === briefId && job.type === type,
      ) ?? null
    );
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const duplicate = await this.findByAccountBriefAndType(input.accountId, input.briefId, input.type);
    if (duplicate) {
      throw new DuplicateDeliveryJobError(input.accountId, input.briefId, input.type);
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
    const job = this.jobs.get(input.deliveryJobId);
    if (!job) {
      throw new JobNotFoundError(input.deliveryJobId);
    }

    const existing = this.attempts.get(input.deliveryJobId) ?? [];
    const nextNumber =
      existing.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1;
    const attemptNumber = input.attemptNumber ?? nextNumber;

    if (existing.some((attempt) => attempt.attemptNumber === attemptNumber)) {
      throw new DuplicateDeliveryAttemptError(input.deliveryJobId, attemptNumber);
    }

    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt ?? (input.status === "running" ? new Date() : undefined),
      createdAt: new Date(),
    };

    this.attempts.set(
      input.deliveryJobId,
      [...existing, attempt].sort((a, b) => a.attemptNumber - b.attemptNumber),
    );
    return attempt;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attempts.get(deliveryJobId) ?? [])].sort(
      (a, b) => b.attemptNumber - a.attemptNumber,
    );
  }

  async getLatestAttempt(deliveryJobId: string): Promise<DeliveryAttempt | null> {
    const attempts = await this.listAttempts(deliveryJobId);
    return attempts[0] ?? null;
  }

  async deleteDeliveryJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    // No CASCADE: attempt history is retained after the intent row is removed.
  }
}
