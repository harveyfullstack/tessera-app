import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import { NoRollbackFlags, type DeliveryRollbackFlags } from "../domain/delivery-rollback";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    attempts: DeliveryAttemptStore,
    flags: DeliveryRollbackFlags = new NoRollbackFlags(),
  ) {
    this.rpc = new DeliveryAttemptRpc(jobs, attempts, flags);
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

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return existing;
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
