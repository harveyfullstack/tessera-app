import type { DeliveryJobRepository } from "../domain/delivery-job-repository";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import type { RollbackFeatureFlag } from "../domain/rollback-feature-flag";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc,
    private readonly deliveryJobs: DeliveryJobRepository,
    private readonly rollbackFlag: RollbackFeatureFlag,
    private readonly now: () => Date = () => new Date(),
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
    return this.attempts.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attempts.retry(jobId);
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

  async displayStatus(job: JobRecord): Promise<string> {
    if (this.rollbackFlag.isEnabled(job.accountId)) {
      return job.status;
    }

    const latest = await this.latestAttempt(job);
    if (!latest) {
      return "queued";
    }

    if (latest.status === "running") {
      const startedAt = latest.startedAt ?? latest.createdAt;
      if (this.now().getTime() - startedAt.getTime() > STUCK_AFTER_MS) {
        return "stuck";
      }
    }

    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }

  private async latestAttempt(job: JobRecord): Promise<DeliveryAttempt | undefined> {
    const deliveryJob = await this.deliveryJobs.findByAccountBriefAndType(
      job.accountId,
      job.briefId,
      job.type,
    );
    if (!deliveryJob) {
      return undefined;
    }

    const history = await this.deliveryJobs.listAttempts(deliveryJob.id);
    return history[0];
  }
}
