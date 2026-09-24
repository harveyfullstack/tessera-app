import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";
import { InMemoryDeliveryRollbackFlag } from "../infrastructure/flags/in-memory-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly executions: DeliveryAttemptRpc = new DeliveryAttemptRpc(
      jobs,
      new InMemoryDeliveryAttemptRepository(),
      new InMemoryDeliveryRollbackFlag(),
    ),
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
    return this.executions.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.executions.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.executions.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.executions.retry(jobId);
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
