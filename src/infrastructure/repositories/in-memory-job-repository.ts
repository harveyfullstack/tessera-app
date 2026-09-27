import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();

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
      attempts: [],
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
    const attempts = [...(job.attempts ?? [])];
    if (input.status === "running") {
      attempts.push({
        attemptNumber: job.retryCount + 1,
        workerId: input.workerId,
        startedAt: now,
      });
    } else if (attempts.length > 0) {
      const last = attempts[attempts.length - 1];
      if (last) {
        attempts[attempts.length - 1] = {
          ...last,
          body: input.details?.errorBody ?? input.errorMessage ?? last.body,
          responseStatus: input.details?.responseStatus ?? last.responseStatus,
          responseLatencyMs: input.details?.responseLatencyMs ?? last.responseLatencyMs,
          completedAt: now,
        };
      }
    }
    const updated: JobRecord = {
      ...job,
      status: input.status,
      workerId: input.workerId ?? job.workerId,
      errorMessage: input.errorMessage,
      updatedAt: now,
      startedAt: input.status === "running" ? now : job.startedAt,
      completedAt:
        input.status === "completed" || input.status === "failed" || input.status === "dlq" || input.status === "cancelled"
          ? now
          : job.completedAt,
      attempts,
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
}
