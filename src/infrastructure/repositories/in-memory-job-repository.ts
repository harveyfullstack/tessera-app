import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly intents = new Map<string, string>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  async findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId && job.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const key = JSON.stringify([input.accountId, input.briefId, input.type]);
    const existingId = this.intents.get(key);
    if (existingId) return this.jobs.get(existingId)!;
    const now = new Date();
    const id = randomUUID();
    const job: JobRecord = {
      id,
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      parentJobId: input.parentJobId,
      type: input.type,
      metadata: input.metadata,
      deliveryJobId: id,
      status: "queued",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(job.id, job);
    this.intents.set(key, id);
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

  async appendExecution(jobId: string, input: UpdateJobExecutionInput, retry = false): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    const intentId = job.deliveryJobId ?? job.id;
    const history = this.attempts.get(intentId) ?? [];
    const now = new Date();
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: intentId,
      attemptNumber: (history.at(-1)?.attemptNumber ?? 0) + 1,
      workerId: input.workerId ?? input.details?.workerId,
      status: input.status,
      responseStatus: input.details?.responseStatus,
      responseLatencyMs: input.details?.responseLatencyMs,
      errorBody: input.details?.errorBody ?? input.errorMessage,
      startedAt: now,
      createdAt: now,
    };
    this.attempts.set(intentId, [...history, attempt]);
    const updated: JobRecord = {
      ...job,
      status: input.status,
      workerId: attempt.workerId ?? job.workerId,
      errorMessage: input.errorMessage,
      retryCount: job.retryCount + (retry ? 1 : 0),
      updatedAt: now,
      startedAt: input.status === "running" ? now : job.startedAt,
      completedAt: ["completed", "failed", "cancelled"].includes(input.status) ? now : job.completedAt,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async attemptsForJob(jobId: string): Promise<DeliveryAttempt[]> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return [...(this.attempts.get(job.deliveryJobId ?? job.id) ?? [])];
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}
