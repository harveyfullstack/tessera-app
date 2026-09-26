import { JobNotFoundError } from "../domain/errors";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DlqSummary,
  JobExecutionDetails,
  JobListOptions,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";

export class JobRecordService {
  private readonly attempts: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    attempts?: DeliveryAttemptRpc,
  ) {
    this.attempts = attempts ?? new DeliveryAttemptRpc(jobs);
  }

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
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return this.attempts.recordExecution(jobId, {
      status: "running",
      workerId,
      details: { workerId },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return this.attempts.recordExecution(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return this.attempts.recordExecution(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return this.attempts.recordRetry(jobId);
  }

  async listByBrief(briefId: string, options?: JobListOptions): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId, options);
  }

  async dlqSummary(briefId: string): Promise<DlqSummary> {
    return this.jobs.getDlqSummary(briefId);
  }

  async drainDlq(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId, { status: "dlq" });
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

  displayStatus(job: JobRecord): string {
    if (this.attempts.isRollbackEnabled()) {
      return job.status ?? "queued";
    }

    return JobRecordService.displayStatus(job);
  }

  static displayStatus(job: JobRecord): string {
    return job.latestAttempt?.status ?? "queued";
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job) as JobType | string;
    return status !== "running";
  }
}
