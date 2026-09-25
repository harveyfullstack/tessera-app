import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  DeliveryAttemptOperation,
  JobRecord,
  JobType,
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

  async recordDeliveryAttempt(
    jobId: string,
    operation: DeliveryAttemptOperation,
  ): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const now = new Date();
    const existing = this.attempts.get(jobId) ?? [];
    const attemptNumber = existing.reduce(
      (latest, record) => Math.max(latest, record.attemptNumber),
      0,
    ) + 1;
    let updated: JobRecord;
    let attempt: Omit<DeliveryAttemptRecord, "jobId" | "attemptNumber" | "createdAt">;

    switch (operation.type) {
      case "mark_running":
        updated = {
          ...job,
          status: "running",
          workerId: operation.workerId,
          errorMessage: undefined,
          startedAt: now,
          updatedAt: now,
        };
        attempt = { status: "running", workerId: operation.workerId };
        break;
      case "mark_failed":
        updated = {
          ...job,
          status: "failed",
          workerId: operation.details?.workerId ?? job.workerId,
          errorMessage: operation.errorMessage,
          completedAt: now,
          updatedAt: now,
        };
        attempt = {
          status: "failed",
          workerId: operation.details?.workerId,
          responseStatus: operation.details?.responseStatus,
          responseLatencyMs: operation.details?.responseLatencyMs,
          errorBody: operation.details?.errorBody,
        };
        break;
      case "mark_completed":
        updated = {
          ...job,
          status: "completed",
          workerId: operation.details.workerId ?? job.workerId,
          errorMessage: undefined,
          completedAt: now,
          updatedAt: now,
        };
        attempt = {
          status: "completed",
          workerId: operation.details.workerId,
          responseStatus: operation.details.responseStatus,
          responseLatencyMs: operation.details.responseLatencyMs,
          errorBody: operation.details.errorBody,
        };
        break;
      case "retry":
        updated = {
          ...job,
          retryCount: job.retryCount + 1,
          updatedAt: now,
        };
        attempt = { status: "retry", workerId: job.workerId };
        break;
      default:
        throw new Error("Unsupported delivery attempt operation");
    }

    const record: DeliveryAttemptRecord = {
      ...attempt,
      jobId,
      attemptNumber,
      createdAt: new Date(),
    };
    this.jobs.set(jobId, updated);
    this.attempts.set(jobId, [...existing, record]);
    return updated;
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
