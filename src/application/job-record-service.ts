import { JobNotFoundError } from "../domain/errors";
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
    private readonly rpc: DeliveryAttemptRpc,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Intent creation stays on jobs for the rollback bar. Execution writes
    // go through DeliveryAttemptRpc, which is the only flag boundary.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.rpc.markRunning(await this.requireJob(jobId), workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.rpc.markFailed(await this.requireJob(jobId), errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.markCompleted(await this.requireJob(jobId), details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.rpc.retry(await this.requireJob(jobId));
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

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return existing;
  }
}
