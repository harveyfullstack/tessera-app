import { JobNotFoundError } from "../domain/errors";
import type { DeliveryExecutionCommand, JobRecord } from "../domain/job";
import type { JobRepository } from "../domain/job-repository";

export interface DeliveryAttemptRollout {
  pilotAccounts: ReadonlySet<string>;
  rollbackAccounts: ReadonlySet<string>;
}

// Deployment supplies the pilot accounts; the default remains fully legacy.
export const deliveryAttemptRollout: DeliveryAttemptRollout = {
  pilotAccounts: new Set<string>(),
  rollbackAccounts: new Set<string>(),
};

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rollout: DeliveryAttemptRollout = deliveryAttemptRollout,
  ) {}

  usesAttempts(accountId: string): boolean {
    return this.rollout.pilotAccounts.has(accountId)
      && !this.rollout.rollbackAccounts.has(accountId);
  }

  async execute(jobId: string, command: DeliveryExecutionCommand): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);

    const appendAttempt = this.usesAttempts(job.accountId);
    return this.jobs.execute(jobId, command, appendAttempt);
  }
}
