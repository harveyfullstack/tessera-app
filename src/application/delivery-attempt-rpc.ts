import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttempt } from "../domain/delivery";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord } from "../domain/job";
import type { DeliverySplitFlags } from "./delivery-split-flags";

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly flags: DeliverySplitFlags,
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId },
      });
    }

    const now = new Date();
    const attempt = await this.attempts.append(jobId, {
      status: "running",
      workerId,
      startedAt: now,
    });
    const updated = await this.jobs.updateExecution(jobId, {
      status: "running",
      workerId,
      details: { workerId, attemptNumber: attempt.attemptNumber },
    });
    return this.project(updated, attempt);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, {
        status: "failed",
        errorMessage,
        details,
      });
    }

    const now = new Date();
    const attempt = await this.attempts.append(jobId, {
      status: "failed",
      workerId: details?.workerId ?? job.workerId,
      responseStatus: details?.responseStatus,
      responseLatencyMs: details?.responseLatencyMs,
      errorBody: details?.errorBody ?? errorMessage,
      startedAt: job.startedAt,
      completedAt: now,
    });
    const updated = await this.jobs.updateExecution(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
    return this.project(updated, attempt);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, {
        status: "completed",
        details,
      });
    }

    const now = new Date();
    const attempt = await this.attempts.append(jobId, {
      status: "completed",
      workerId: details.workerId ?? job.workerId,
      responseStatus: details.responseStatus,
      responseLatencyMs: details.responseLatencyMs,
      errorBody: details.errorBody,
      startedAt: job.startedAt,
      completedAt: now,
    });
    const updated = await this.jobs.updateExecution(jobId, {
      status: "completed",
      details,
    });
    return this.project(updated, attempt);
  }

  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.incrementRetry(jobId);
    }

    const attempt = await this.attempts.append(jobId, {
      status: "failed",
      workerId: job.workerId,
      errorBody: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt ?? new Date(),
    });
    const updated = await this.jobs.incrementRetry(jobId);
    return this.project(updated, attempt);
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  private project(job: JobRecord, attempt: DeliveryAttempt): JobRecord {
    return {
      ...job,
      status: attempt.status,
      workerId: attempt.workerId,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    };
  }
}
