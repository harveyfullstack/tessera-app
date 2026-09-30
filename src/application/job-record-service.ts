import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc = new DeliveryAttemptRpc(jobs),
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    return this.jobs.ensure(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "running", workerId, details: { workerId } },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "failed", errorMessage, details },
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "completed", details },
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, { kind: "retry" });
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
