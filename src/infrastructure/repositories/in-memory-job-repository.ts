import { randomUUID } from "crypto";
import {
  DeliveryJobDeleteRestrictedError,
  DeliveryJobNotFoundError,
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
  JobNotFoundError,
} from "../../domain/errors";
import type {
  DeliveryJobRepository,
  JobRepository,
} from "../../domain/job-repository";
import {
  computeOldAttemptCount,
  type AggregateParityResult,
  type AttemptParityResult,
  type CreateDeliveryAttemptInput,
  type CreateJobInput,
  type DeliveryAttemptRecord,
  type DeliveryJobRecord,
  type JobRecord,
  type JobType,
  type UpdateJobExecutionInput,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository, DeliveryJobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly deliveryJobs = new Map<string, DeliveryJobRecord>();
  private readonly deliveryAttempts = new Map<string, DeliveryAttemptRecord[]>();

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

  // --- Canonical Phase-2 DeliveryJob & DeliveryAttempt methods ---

  async findDeliveryJob(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<DeliveryJobRecord | null> {
    for (const job of this.deliveryJobs.values()) {
      if (job.accountId === accountId && job.briefId === briefId && job.type === type) {
        return job;
      }
    }
    return null;
  }

  async findDeliveryJobById(id: string): Promise<DeliveryJobRecord | null> {
    return this.deliveryJobs.get(id) ?? null;
  }

  async createDeliveryJob(input: CreateJobInput): Promise<DeliveryJobRecord> {
    const existing = await this.findDeliveryJob(input.accountId, input.briefId, input.type);
    if (existing) {
      throw new DuplicateDeliveryJobError(input.accountId, input.briefId, input.type);
    }

    const now = new Date();
    const deliveryJob: DeliveryJobRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      parentJobId: input.parentJobId,
      type: input.type,
      metadata: input.metadata,
      createdAt: now,
    };

    this.deliveryJobs.set(deliveryJob.id, deliveryJob);
    return deliveryJob;
  }

  async createDeliveryAttempt(
    input: CreateDeliveryAttemptInput,
  ): Promise<DeliveryAttemptRecord> {
    const job = this.deliveryJobs.get(input.deliveryJobId);
    if (!job) {
      throw new DeliveryJobNotFoundError(input.deliveryJobId);
    }

    const attempts = this.deliveryAttempts.get(input.deliveryJobId) ?? [];
    if (attempts.some((a) => a.attemptNumber === input.attemptNumber)) {
      throw new DuplicateDeliveryAttemptError(input.deliveryJobId, input.attemptNumber);
    }

    const now = new Date();
    const attempt: DeliveryAttemptRecord = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt ?? (input.status === "running" ? now : undefined),
      completedAt:
        input.completedAt ??
        (input.status === "completed" || input.status === "failed" || input.status === "cancelled"
          ? now
          : undefined),
      createdAt: now,
    };

    attempts.push(attempt);
    this.deliveryAttempts.set(input.deliveryJobId, attempts);
    return attempt;
  }

  async listDeliveryAttempts(deliveryJobId: string): Promise<DeliveryAttemptRecord[]> {
    const attempts = this.deliveryAttempts.get(deliveryJobId) ?? [];
    return [...attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async getLatestDeliveryAttempt(
    deliveryJobId: string,
  ): Promise<DeliveryAttemptRecord | null> {
    const attempts = this.deliveryAttempts.get(deliveryJobId) ?? [];
    if (attempts.length === 0) {
      return null;
    }
    // Index emulation on (delivery_job_id, attempt_number DESC)
    return [...attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0] ?? null;
  }

  async deleteDeliveryJob(id: string): Promise<void> {
    const attempts = this.deliveryAttempts.get(id) ?? [];
    if (attempts.length > 0) {
      // Disallow CASCADE deletion: deleting delivery_jobs cannot take attempt history with it
      throw new DeliveryJobDeleteRestrictedError(id, attempts.length);
    }
    this.deliveryJobs.delete(id);
  }

  async migrateJobsToDeliverySchema(): Promise<AggregateParityResult> {
    // Group all pre-migration jobs by intent (accountId, briefId, type)
    const grouped = new Map<string, JobRecord[]>();
    for (const job of this.jobs.values()) {
      const key = `${job.accountId}:${job.briefId}:${job.type}`;
      const list = grouped.get(key) ?? [];
      list.push(job);
      grouped.set(key, list);
    }

    for (const jobList of grouped.values()) {
      // Sort to establish canonical earliest intent row
      jobList.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
      );
      const canonical = jobList[0]!;

      let deliveryJob = await this.findDeliveryJob(
        canonical.accountId,
        canonical.briefId,
        canonical.type,
      );
      if (!deliveryJob) {
        deliveryJob = {
          id: canonical.id,
          accountId: canonical.accountId,
          briefId: canonical.briefId,
          taskId: canonical.taskId,
          parentJobId: canonical.parentJobId,
          type: canonical.type,
          metadata: canonical.metadata,
          createdAt: canonical.createdAt,
        };
        this.deliveryJobs.set(deliveryJob.id, deliveryJob);
      }

      // Migrate all execution attempts from all matching job rows without loss
      const jobAttempts = this.deliveryAttempts.get(deliveryJob.id) ?? [];
      let currentAttemptNumber = jobAttempts.length;
      for (const job of jobList) {
        const attemptsForJob = computeOldAttemptCount(job);
        if (attemptsForJob === 0) {
          continue;
        }

        // Backfill prior retried attempts
        for (let i = 1; i < attemptsForJob; i++) {
          currentAttemptNumber++;
          jobAttempts.push({
            id: randomUUID(),
            deliveryJobId: deliveryJob.id,
            attemptNumber: currentAttemptNumber,
            workerId: job.workerId,
            status: "failed",
            errorBody: "Historical attempt retried (pre-migration backfill)",
            startedAt: job.startedAt,
            completedAt: job.updatedAt,
            createdAt: job.createdAt,
          });
        }

        // Insert current attempt
        currentAttemptNumber++;
        jobAttempts.push({
          id: randomUUID(),
          deliveryJobId: deliveryJob.id,
          attemptNumber: currentAttemptNumber,
          workerId: job.workerId,
          status: job.status,
          responseStatus:
            job.status === "completed" ? 200 : job.status === "failed" ? 500 : undefined,
          errorBody: job.errorMessage,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          createdAt: job.updatedAt ?? job.createdAt,
        });
      }
      this.deliveryAttempts.set(deliveryJob.id, jobAttempts);
    }

    return this.verifyAttemptParity();
  }

  async verifyAttemptParity(targetDeliveryJobId?: string): Promise<AggregateParityResult> {
    const jobParities: AttemptParityResult[] = [];

    const intentToJobs = new Map<string, JobRecord[]>();
    for (const job of this.jobs.values()) {
      const key = `${job.accountId}:${job.briefId}:${job.type}`;
      const list = intentToJobs.get(key) ?? [];
      list.push(job);
      intentToJobs.set(key, list);
    }

    const deliveryJobsToCheck = targetDeliveryJobId
      ? [this.deliveryJobs.get(targetDeliveryJobId)].filter(
          (j): j is DeliveryJobRecord => Boolean(j),
        )
      : [...this.deliveryJobs.values()];

    for (const deliveryJob of deliveryJobsToCheck) {
      const key = `${deliveryJob.accountId}:${deliveryJob.briefId}:${deliveryJob.type}`;
      const relatedJobs = intentToJobs.get(key) ?? [];
      const oldAttemptCount = relatedJobs.reduce(
        (acc, job) => acc + computeOldAttemptCount(job),
        0,
      );
      const attempts = this.deliveryAttempts.get(deliveryJob.id) ?? [];
      const newAttemptCount = attempts.length;

      jobParities.push({
        deliveryJobId: deliveryJob.id,
        accountId: deliveryJob.accountId,
        briefId: deliveryJob.briefId,
        type: deliveryJob.type,
        oldAttemptCount,
        newAttemptCount,
        matches: oldAttemptCount === newAttemptCount,
      });
    }

    const totalOldAttempts = targetDeliveryJobId
      ? jobParities.reduce((acc, p) => acc + p.oldAttemptCount, 0)
      : [...this.jobs.values()].reduce((acc, job) => acc + computeOldAttemptCount(job), 0);
    const totalNewAttempts = targetDeliveryJobId
      ? jobParities.reduce((acc, p) => acc + p.newAttemptCount, 0)
      : [...this.deliveryAttempts.values()].reduce((acc, list) => acc + list.length, 0);
    const matches =
      (targetDeliveryJobId ? jobParities.length > 0 : true) &&
      jobParities.every((p) => p.matches) &&
      totalOldAttempts === totalNewAttempts;

    return {
      totalOldAttempts,
      totalNewAttempts,
      matches,
      jobParities,
    };
  }
}

