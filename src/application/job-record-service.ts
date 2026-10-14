import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DisplayStatus,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

/** A running attempt whose started_at is older than this is shown as stuck. */
export const STUCK_ATTEMPT_THRESHOLD_MS = 5 * 60 * 1000;

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

    // Not atomic: two concurrent callers can both miss the lookup and insert duplicate intent rows.
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

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return existing;
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

  /**
   * Status shown in the UI. On the attempt path the latest delivery_attempts
   * row is authoritative; a running attempt older than the stuck threshold is
   * reported as stuck. Jobs with no attempt rows (new or pre-cutover), and
   * accounts outside the pilot or under rollback, fall back to jobs.status.
   */
  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<DisplayStatus> {
    if (!this.rpc.usesAttemptPath(job.accountId)) {
      return job.status;
    }

    const latest = await this.rpc.latestAttempt(job);
    if (!latest) {
      return job.status;
    }

    const runningFor = now.getTime() - latest.startedAt.getTime();
    if (latest.status === "running" && runningFor > STUCK_ATTEMPT_THRESHOLD_MS) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord, now: Date = new Date()): Promise<boolean> {
    const status = await this.displayStatus(job, now);
    // A stuck attempt is still running as far as storage knows.
    return status !== "running" && status !== "stuck";
  }
}
