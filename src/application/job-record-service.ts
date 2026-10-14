import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Not atomic: two concurrent callers can both miss the lookup and insert duplicate intent rows.
    return this.jobs.create(input);
  }

  markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attempts.markRunning(jobId, workerId);
  }

  markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.markFailed(jobId, errorMessage, details);
  }

  markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.markCompleted(jobId, details);
  }

  retry(jobId: string): Promise<JobRecord> {
    return this.attempts.retry(jobId);
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
    // Falls back to the mutable jobs.status column; there is no per-attempt history to derive status from.
    return job.status ?? "queued";
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job) as JobType | string;
    return status !== "running";
  }
}
