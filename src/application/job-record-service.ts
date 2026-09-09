import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { DeliveryStore, JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  private readonly attemptRpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    attemptRpc?: DeliveryAttemptRpc,
  ) {
    this.attemptRpc = attemptRpc ?? new DeliveryAttemptRpc(jobs as DeliveryStore);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByIntentKey(input.accountId, input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Unique (account_id, brief_id, type) is enforced at the table. A racy
    // repository that skips the constraint can still insert duplicates.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attemptRpc.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attemptRpc.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attemptRpc.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attemptRpc.retry(jobId);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttempt[]> {
    return this.attemptRpc.listAttempts(jobId);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
  }

  async ensureWebhookDispatchJob(
    accountId: string,
    briefId: string,
    metadata: JobMetadata,
  ): Promise<JobRecord> {
    return this.ensureJobRecord({
      accountId,
      briefId,
      type: "dispatch_webhook",
      metadata,
    });
  }

  static displayStatus(job: JobRecord): string {
    // Pre-migration fallback the migration brief intends to remove.
    return job.status ?? "queued";
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job) as JobType | string;
    return status !== "running";
  }
}
