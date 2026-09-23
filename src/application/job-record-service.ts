import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import {
  deriveDisplayStatus,
  systemClock,
  type Clock,
  type JobDisplayStatus,
} from "./delivery-display-status";
import type { DeliveryAttemptReader } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc,
    private readonly attemptHistory: DeliveryAttemptReader,
    private readonly now: Clock = systemClock,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Pre-migration behavior. If two callers race, duplicate intent rows are possible.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const { job } = await this.attempts.markRunning(jobId, workerId);
    return job;
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const { job } = await this.attempts.markFailed(jobId, errorMessage, details);
    return job;
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const { job } = await this.attempts.markCompleted(jobId, details);
    return job;
  }

  async retry(jobId: string): Promise<JobRecord> {
    const { job } = await this.attempts.retry(jobId);
    return job;
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

  // While the account's rollback window is open the legacy jobs.status column
  // is still dual-written, so it is shown as-is; otherwise the status is
  // derived from the job's delivery_attempts.
  async displayStatus(job: JobRecord): Promise<JobDisplayStatus> {
    if (await this.attempts.isRollbackWindowOpen(job.accountId)) {
      return job.status;
    }
    return deriveDisplayStatus(await this.attemptHistory.listByJob(job.id), this.now());
  }

  // A stuck run is still a running attempt, so it blocks a new delivery too.
  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running" && status !== "stuck";
  }
}
