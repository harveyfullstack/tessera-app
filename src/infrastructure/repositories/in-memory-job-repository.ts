import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  DlqSummary,
  JobListOptions,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  constructor(private readonly defaultRetryBudget = 8) {}

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
        job.accountId === input.accountId && job.briefId === input.briefId && job.type === input.type,
    );
    if (duplicate) {
      return duplicate;
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
    this.attempts.set(job.id, []);
    return job;
  }

  async updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const attempt = await this.appendAttempt(jobId, input);
    const now = new Date();
    const updated: JobRecord = {
      ...job,
      status: input.status,
      workerId: input.workerId ?? input.details?.workerId ?? job.workerId,
      errorMessage: input.errorMessage,
      latestAttempt: attempt,
      dlqStatus: this.isPastRetryBudget(job, attempt) ? "dlq" : job.dlqStatus,
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

  async appendAttempt(jobId: string, input: UpdateJobExecutionInput): Promise<DeliveryAttempt> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const existing = this.attempts.get(jobId) ?? [];
    const now = new Date();
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: jobId,
      attemptNumber: input.details?.attemptNumber ?? existing.length + 1,
      workerId: input.workerId ?? input.details?.workerId,
      status: input.status,
      responseStatus: input.details?.responseStatus,
      responseLatencyMs: input.details?.responseLatencyMs,
      errorBody: input.details?.errorBody ?? input.errorMessage,
      startedAt: input.status === "running" ? now : undefined,
      completedAt: input.status === "running" ? undefined : now,
      createdAt: now,
    };

    const previous = existing.find((item) => item.attemptNumber === attempt.attemptNumber);
    if (previous) {
      const merged: DeliveryAttempt = {
        ...previous,
        ...attempt,
        startedAt: previous.startedAt ?? attempt.startedAt,
        createdAt: previous.createdAt,
      };
      this.attempts.set(
        jobId,
        existing.map((item) => (item.attemptNumber === attempt.attemptNumber ? merged : item)),
      );
      return merged;
    }

    this.attempts.set(jobId, [...existing, attempt]);
    return attempt;
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

  async listByBrief(briefId: string, options: JobListOptions = {}): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .filter((job) => {
        if (!options.status) {
          return true;
        }
        return options.status === "dlq" ? job.dlqStatus === "dlq" : job.status === options.status;
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async getDlqSummary(briefId: string): Promise<DlqSummary> {
    const dlqJobs = await this.listByBrief(briefId, { status: "dlq" });
    const lastAttemptBodies = dlqJobs.flatMap((job) =>
      (this.attempts.get(job.id) ?? [])
        .slice()
        .sort((a, b) => b.attemptNumber - a.attemptNumber)
        .map((attempt) => attempt.errorBody)
        .filter((body): body is string => Boolean(body))
        .slice(0, 3),
    );

    return { count: dlqJobs.length, lastAttemptBodies: lastAttemptBodies.slice(0, 3) };
  }

  private isPastRetryBudget(job: JobRecord, attempt: DeliveryAttempt): boolean {
    const accountBudget = Number((job.metadata as { retryBudget?: number }).retryBudget);
    const budget = Number.isFinite(accountBudget) && accountBudget > 0 ? accountBudget : this.defaultRetryBudget;
    return job.type === "dispatch_webhook" && attempt.status === "failed" && attempt.attemptNumber >= budget;
  }
}
