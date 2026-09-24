import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  DeliveryDisplayStatus,
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

  async displayStatus(jobId: string, now = new Date()): Promise<DeliveryDisplayStatus> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (!(await this.jobs.getRollout(job.accountId)).enabled) return job.status;
    const attempts = await this.jobs.listAttempts(jobId);
    const latest = attempts.reduce<(typeof attempts)[number] | undefined>(
      (result, attempt) => !result || attempt.attemptNumber > result.attemptNumber ? attempt : result,
      undefined,
    );
    if (!latest) return "queued";
    if (latest.status === "running" && latest.startedAt && now.getTime() - latest.startedAt.getTime() > 5 * 60 * 1000) {
      return "stuck";
    }
    return latest.status;
  }

  setEnabled(accountId: string, enabled: boolean): Promise<DeliveryRollout> {
    return this.jobs.setRollout(accountId, enabled);
  }
}
