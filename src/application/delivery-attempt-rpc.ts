import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type { JobRecord, UpdateJobExecutionInput } from "../domain/job";

export type RollbackFlag = (accountId: string) => boolean;

// All execution writes pass through this boundary. The repository serializes
// the attempt-number allocation and append with the legacy jobs update.
export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rollbackEnabled: RollbackFlag = () => false,
  ) {}

  async write(jobId: string, input: UpdateJobExecutionInput, retry = false): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (this.rollbackEnabled(job.accountId)) {
      return retry ? this.jobs.incrementRetry(jobId) : this.jobs.updateExecution(jobId, input);
    }
    return this.jobs.appendExecution(jobId, input, retry);
  }
}
