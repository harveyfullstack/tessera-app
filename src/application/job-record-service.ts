import { JobNotFoundError } from "../domain/errors";
import {
  DEFAULT_RETRY_BUDGET_CONFIG,
  retryBudgetFor,
  summarizeDlq,
  type DlqSummary,
  type RetryBudgetConfig,
} from "./dead-letter-queue";
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

/** A job as listed for a brief; dlq is null unless the job is DLQ-bound. */
export type JobListing = JobRecord & { dlq: DlqSummary | null };

export interface JobListFilter {
  /** "dlq" keeps only DLQ-bound jobs. */
  status?: "dlq" | undefined;
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly rpc: DeliveryAttemptRpc,
    private readonly retryBudgets: RetryBudgetConfig = DEFAULT_RETRY_BUDGET_CONFIG,
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

  async listByBrief(briefId: string, filter: JobListFilter = {}): Promise<JobListing[]> {
    const rows = await this.jobs.listByBrief(briefId);
    const listed = await Promise.all(
      rows.map(async (job) => ({ ...job, dlq: await this.dlqSummary(job) })),
    );
    return filter.status === "dlq" ? listed.filter((job) => job.dlq !== null) : listed;
  }

  /**
   * DLQ state for a dispatch job, derived from its append-only attempts.
   * Attempts are authoritative only on the attempt path, so legacy and
   * rolled-back accounts never report a job as DLQ-bound.
   */
  async dlqSummary(job: JobRecord): Promise<DlqSummary | null> {
    if (job.type !== "dispatch_webhook" || !this.rpc.usesAttemptPath(job.accountId)) {
      return null;
    }
    const attempts = await this.rpc.listAttempts(job);
    return summarizeDlq(job, attempts, retryBudgetFor(this.retryBudgets, job.accountId));
  }

  /**
   * drain_dlq processor: when a dispatch job is past its retry budget, moves
   * it to the Dead Letter Queue by ensuring the brief's drain_dlq job, which
   * points back at the dispatch job and carries its metadata (and so its
   * endpointUrl). Returns the drain_dlq job, or null when the job is not
   * DLQ-bound. No attempt row is updated and no status value is added.
   */
  async moveToDlqIfPastBudget(jobId: string): Promise<JobRecord | null> {
    const job = await this.requireJob(jobId);
    if (!(await this.dlqSummary(job))) {
      return null;
    }
    return this.ensureJobRecord({
      accountId: job.accountId,
      briefId: job.briefId,
      taskId: job.taskId,
      parentJobId: job.id,
      type: "drain_dlq",
      metadata: job.metadata,
    });
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
