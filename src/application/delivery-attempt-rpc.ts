import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord, JobStatus } from "../domain/job";

/** The only execution-write entry point; rollback is evaluated per account. */
export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rollbackEnabled: (accountId: string) => boolean = () => false,
  ) {}

  isRollbackEnabled(accountId: string): boolean {
    return this.rollbackEnabled(accountId);
  }

  async write(
    jobId: string,
    status: JobStatus,
    details?: JobExecutionDetails,
    errorMessage?: string,
  ): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);

    const input = { status, workerId: details?.workerId, errorMessage, details };
    if (!this.isRollbackEnabled(job.accountId)) {
      await this.jobs.appendAttempt(jobId, input);
    }
    // Shadow the legacy fields during the rollout so a per-account rollback
    // still has an immediately usable execution state.
    if (status === "queued") return this.jobs.incrementRetry(jobId);
    return this.jobs.updateExecution(jobId, input);
  }
}
