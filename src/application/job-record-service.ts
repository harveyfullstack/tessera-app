import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export type DisplayStatus = JobStatus | "stuck";

export const STUCK_AFTER_MS = 5 * 60 * 1000;

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

  // UI status: the latest attempt's status, or "stuck" when that attempt has
  // been running longer than STUCK_AFTER_MS. Jobs without attempt rows (new,
  // pre-cutover, non-pilot, or rolled back) keep reading jobs.status.
  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<DisplayStatus> {
    const latest = await this.attempts.latestAttempt(job);
    if (!latest) {
      return job.status;
    }

    if (
      latest.status === "running" &&
      now.getTime() - latest.startedAt.getTime() > STUCK_AFTER_MS
    ) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }
}
