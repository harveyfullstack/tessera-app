import type { DeliveryAttempt } from "../domain/delivery";
import type { DeliveryAttemptRepository } from "../domain/delivery-repository";
import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { DeliverySplitFlags } from "./delivery-split-flags";

export const STUCK_RUNNING_AFTER_MS = 5 * 60 * 1000;

export function deriveDisplayStatus(
  latestAttempt: DeliveryAttempt | null,
  now = new Date(),
): string {
  if (!latestAttempt) {
    return "queued";
  }

  if (
    latestAttempt.status === "running" &&
    latestAttempt.startedAt !== undefined &&
    now.getTime() - latestAttempt.startedAt.getTime() > STUCK_RUNNING_AFTER_MS
  ) {
    return "stuck";
  }

  return latestAttempt.status;
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rpc: DeliveryAttemptRpc,
    private readonly flags: DeliverySplitFlags,
    private readonly deliveryAttempts: DeliveryAttemptRepository,
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

  async displayStatus(job: JobRecord, now = new Date()): Promise<string> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return job.status ?? "queued";
    }

    const latest = await this.deliveryAttempts.findLatestByDeliveryJobId(job.id);
    return deriveDisplayStatus(latest, now);
  }

  async canStartNewDelivery(job: JobRecord, now = new Date()): Promise<boolean> {
    const status = await this.displayStatus(job, now);
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
