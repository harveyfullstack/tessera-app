import { randomUUID } from "crypto";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
  JobNotFoundError,
} from "../../domain/errors";
import type { DeliveryJobRepository } from "../../domain/delivery-job-repository";
import type {
  CreateDeliveryAttemptInput,
  CreateJobInput,
  DeliveryAttempt,
  DeliveryJob,
  JobType,
} from "../../domain/job";

export class InMemoryDeliveryJobRepository implements DeliveryJobRepository {
  private readonly jobs = new Map<string, DeliveryJob>();
  private readonly attempts = new Map<string, DeliveryAttempt>();

  async findByAccountBriefAndType(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<DeliveryJob | null> {
    return (
      [...this.jobs.values()].find(
        (job) => job.accountId === accountId && job.briefId === briefId && job.type === type,
      ) ?? null
    );
  }

  async findById(jobId: string): Promise<DeliveryJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<DeliveryJob> {
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.accountId === input.accountId &&
        job.briefId === input.briefId &&
        job.type === input.type,
    );
    if (existing) {
      throw new DuplicateDeliveryJobError(input.accountId, input.briefId, input.type);
    }

    const job: DeliveryJob = {
      id: randomUUID(),
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      parentJobId: input.parentJobId,
      type: input.type,
      metadata: input.metadata,
      createdAt: new Date(),
    };

    this.jobs.set(job.id, job);
    return job;
  }

  async appendAttempt(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    if (!this.jobs.has(input.deliveryJobId)) {
      throw new JobNotFoundError(input.deliveryJobId);
    }

    const duplicate = [...this.attempts.values()].some(
      (attempt) =>
        attempt.deliveryJobId === input.deliveryJobId &&
        attempt.attemptNumber === input.attemptNumber,
    );
    if (duplicate) {
      throw new DuplicateDeliveryAttemptError(input.deliveryJobId, input.attemptNumber);
    }

    const createdAt = new Date();
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt ?? (input.status === "running" ? createdAt : undefined),
      createdAt,
    };

    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.deliveryJobId === deliveryJobId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
  }
}
