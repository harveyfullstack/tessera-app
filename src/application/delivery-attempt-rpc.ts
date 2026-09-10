import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord, JobStatus } from "../domain/job";
import type { DeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";

interface RecordAttemptInput {
  status: JobStatus;
  workerId?: string | undefined;
  errorMessage?: string | undefined;
  details?: JobExecutionDetails | undefined;
}

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly rollbackFlags: DeliveryAttemptRollbackFlags,
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.record(jobId, {
      status: "running",
      workerId,
      details: { workerId },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.record(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.record(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (this.rollbackFlags.isRollbackEnabled(job.accountId)) {
      return this.jobs.incrementRetry(jobId);
    }

    const attemptNumber = await this.attempts.nextAttemptNumber(jobId);
    await this.attempts.insert({
      deliveryJobId: jobId,
      attemptNumber,
      status: "queued",
    });

    return this.jobs.incrementRetry(jobId);
  }

  private async record(jobId: string, input: RecordAttemptInput): Promise<JobRecord> {
    const job = await this.requireJob(jobId);

    if (this.rollbackFlags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, {
        status: input.status,
        workerId: input.workerId,
        errorMessage: input.errorMessage,
        details: input.details,
      });
    }

    const attemptNumber = await this.attempts.nextAttemptNumber(jobId);
    await this.attempts.insert({
      deliveryJobId: jobId,
      attemptNumber,
      workerId: input.workerId ?? input.details?.workerId,
      status: input.status,
      responseStatus: input.details?.responseStatus,
      responseLatencyMs: input.details?.responseLatencyMs,
      errorBody: input.details?.errorBody ?? input.errorMessage,
      completedAt:
        input.status === "completed" || input.status === "failed" || input.status === "cancelled"
          ? new Date()
          : undefined,
    });

    return this.jobs.updateExecution(jobId, {
      status: input.status,
      workerId: input.workerId,
      errorMessage: input.errorMessage,
      details: input.details,
    });
  }

  async getLatestAttempt(jobId: string): Promise<DeliveryAttemptRecord | null> {
    return this.attempts.findLatestByJobId(jobId);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]> {
    return this.attempts.listByJobId(jobId);
  }

  async countAttempts(jobId: string): Promise<number> {
    return this.attempts.countByJobId(jobId);
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }
}
