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
  JobStatus,
} from "../domain/job";

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptStore,
    flags: DeliveryRollbackFlags = new NoRollbackFlags(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rpc = new DeliveryAttemptRpc(jobs, attempts, flags, now);
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

  async displayStatus(job: JobRecord): Promise<JobStatus | "stuck"> {
    if (this.rpc.isRollbackEnabled(job.accountId)) {
      return job.status;
    }

    const latest = await this.attempts.latest(job.id);
    if (!latest) {
      return "queued";
    }
    if (latest.status === "running" && this.isStuck(latest)) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }

  private isStuck(attempt: { startedAt?: Date | undefined }): boolean {
    if (attempt.startedAt === undefined) {
      return false;
    }
    return this.now().getTime() - attempt.startedAt.getTime() > STUCK_AFTER_MS;
  }
}
