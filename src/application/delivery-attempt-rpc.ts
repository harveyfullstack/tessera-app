import {
  DeliveryRollbackUnavailableError,
  JobNotFoundError,
} from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  DeliveryAttemptOperation,
  JobExecutionDetails,
  JobRecord,
} from "../domain/job";

export type DeliveryRollbackFeatureFlag = (accountId: string) => boolean;

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly isRollbackEnabled: DeliveryRollbackFeatureFlag = () => false,
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const { job } = await this.loadJob(jobId);
    return this.record(job, { type: "mark_running", workerId });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const { job } = await this.loadJob(jobId);
    return this.record(job, { type: "mark_failed", errorMessage, details });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const { job } = await this.loadJob(jobId);
    return this.record(job, { type: "mark_completed", details });
  }

  async retry(jobId: string): Promise<JobRecord> {
    const { job } = await this.loadJob(jobId);
    return this.record(job, { type: "retry" });
  }

  private async loadJob(
    jobId: string,
  ): Promise<{ job: JobRecord }> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (this.isRollbackEnabled(job.accountId)) {
      throw new DeliveryRollbackUnavailableError(job.accountId);
    }
    return { job };
  }

  private record(job: JobRecord, operation: DeliveryAttemptOperation): Promise<JobRecord> {
    return this.jobs.recordDeliveryAttempt(job.id, operation);
  }
}
