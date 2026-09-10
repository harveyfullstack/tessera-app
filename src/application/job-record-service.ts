import { DuplicateDeliveryJobError, JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { DeliveryRollbackFlags } from "./delivery-rollback-flags";

export class JobRecordService {
  readonly flags: DeliveryRollbackFlags;
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    flags: DeliveryRollbackFlags = new DeliveryRollbackFlags(),
    rpc?: DeliveryAttemptRpc,
  ) {
    this.flags = flags;
    this.rpc = rpc ?? new DeliveryAttemptRpc(jobs, flags);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByAccountBriefAndType(
      input.accountId,
      input.briefId,
      input.type,
    );
    if (existing) {
      return existing;
    }

    try {
      return await this.jobs.create(input);
    } catch (error) {
      if (error instanceof DuplicateDeliveryJobError) {
        const raced = await this.jobs.findByAccountBriefAndType(
          input.accountId,
          input.briefId,
          input.type,
        );
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const existing = await this.requireJob(jobId);
    return this.rpc.markRunning(existing, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const existing = await this.requireJob(jobId);
    return this.rpc.markFailed(existing, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const existing = await this.requireJob(jobId);
    return this.rpc.markCompleted(existing, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    const existing = await this.requireJob(jobId);
    return this.rpc.retry(existing);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
  }

  async listAttempts(jobId: string) {
    return this.jobs.listAttempts(jobId);
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

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return existing;
  }
}
