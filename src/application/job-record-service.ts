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
import type { DeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attemptRpc: DeliveryAttemptRpc,
    private readonly rollbackFlags: DeliveryAttemptRollbackFlags,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

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
    return job.status ?? "queued";
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job) as JobType | string;
    return status !== "running";
  }
}
