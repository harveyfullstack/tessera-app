import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  private static readonly stuckAttemptThresholdMs = 5 * 60 * 1000;
  private readonly deliveryAttempts: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    deliveryAttempts?: DeliveryAttemptRpc,
  ) {
    this.deliveryAttempts = deliveryAttempts ?? new DeliveryAttemptRpc(jobs);
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
    return this.deliveryAttempts.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.deliveryAttempts.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.deliveryAttempts.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.deliveryAttempts.retry(jobId);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
  }

  async ensureDlqEntry(
    input: CreateJobInput & { type: "drain_dlq"; parentJobId: string },
  ): Promise<JobRecord> {
    return this.jobs.ensureDlqEntry(input);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]> {
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

  async displayStatus(job: JobRecord): Promise<string> {
    if (this.deliveryAttempts.isRollbackEnabledFor(job.accountId)) {
      return job.status ?? "queued";
    }

    const attempts = await this.jobs.listAttempts(job.id);
    const latestAttempt = attempts.reduce<DeliveryAttemptRecord | undefined>(
      (latest, attempt) =>
        !latest || attempt.attemptNumber > latest.attemptNumber ? attempt : latest,
      undefined,
    );

    if (!latestAttempt) {
      return "queued";
    }

    if (
      latestAttempt.status === "running" &&
      Date.now() - latestAttempt.createdAt.getTime() > JobRecordService.stuckAttemptThresholdMs
    ) {
      return "stuck";
    }

    return latestAttempt.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }
}
