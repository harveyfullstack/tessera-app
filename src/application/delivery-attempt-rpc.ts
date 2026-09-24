import { JobNotFoundError } from "../domain/errors";
import type {
  JobRepository,
} from "../domain/job-repository";
import type {
  DeliveryRollout,
  JobRecord,
  UpdateJobExecutionInput,
} from "../domain/job";

export class DeliveryAttemptRpc {
  constructor(private readonly jobs: JobRepository) {}

  async append(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    const rollout = await this.jobs.getRollout(job.accountId);
    // Capture and compatibility writes remain atomic and active during rollback.
    if (rollout.enabled && !(await this.jobs.findIntent(jobId))) {
      throw new Error(`Enabled account is missing immutable delivery intent: ${jobId}`);
    }
    return this.jobs.appendExecution(jobId, input);
  }

  getRollout(accountId: string): Promise<DeliveryRollout> {
    return this.jobs.getRollout(accountId);
  }

  setEnabled(accountId: string, enabled: boolean): Promise<DeliveryRollout> {
    return this.jobs.setRollout(accountId, enabled);
  }
}
