import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export type DisplayStatus = JobStatus | "stuck";

// A running attempt whose started_at is older than this is shown as stuck.
export const STUCK_ATTEMPT_THRESHOLD_MS = 5 * 60 * 1000;

function latestAttempt(attempts: readonly DeliveryAttempt[]): DeliveryAttempt | undefined {
  return attempts.reduce<DeliveryAttempt | undefined>(
    (latest, attempt) =>
      !latest || attempt.attemptNumber > latest.attemptNumber ? attempt : latest,
    undefined,
  );
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly executionWrites: DeliveryAttemptRpc,
    private readonly attempts: DeliveryAttemptStore,
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
    return this.executionWrites.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.executionWrites.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.executionWrites.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.executionWrites.retry(jobId);
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

  // UI status comes from the latest attempt. jobs.status is the fallback when the
  // account is off the attempt path (not a pilot, or rolled back) or the job has
  // no attempt rows: new jobs default to queued, pre-cutover jobs keep theirs.
  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<DisplayStatus> {
    if (!job.deliveryJobId || !this.executionWrites.usesAttemptPath(job.accountId)) {
      return job.status;
    }

    const latest = latestAttempt(await this.attempts.listAttempts(job.deliveryJobId));
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
    return (await this.displayStatus(job, now)) !== "running";
  }
}
