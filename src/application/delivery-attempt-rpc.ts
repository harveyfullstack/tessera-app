import type { JobRepository } from "../domain/job-repository";
import type { JobRecord, UpdateJobExecutionInput } from "../domain/job";

export interface DeliveryAttemptRpcOptions {
  rollbackEnabled?: () => boolean;
}

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly options: DeliveryAttemptRpcOptions = {},
  ) {}

  isRollbackEnabled(): boolean {
    return this.options.rollbackEnabled?.() ?? false;
  }

  async recordExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    // Rollback keeps the legacy job projection authoritative, but all callers
    // still pass through this RPC so the split can be toggled from one boundary.
    return this.jobs.updateExecution(jobId, {
      ...input,
      details: input.details
        ? { ...input.details, attemptNumber: undefined }
        : undefined,
    });
  }

  async recordRetry(jobId: string): Promise<JobRecord> {
    await this.jobs.updateExecution(jobId, {
      status: "queued",
    });
    return this.jobs.incrementRetry(jobId);
  }
}
