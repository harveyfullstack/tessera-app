import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { DeliveryRetryBudget } from "./delivery-retry-budget";

export type DisplayStatus = JobStatus | "stuck";

export const STUCK_AFTER_MS = 5 * 60 * 1000;

export const DLQ_LAST_ATTEMPTS = 3;

const OUTCOME_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

// An attempt body is identified only by (deliveryJobId, attemptNumber).
export interface DlqAttemptBody {
  deliveryJobId: string;
  attemptNumber: number;
  status: JobStatus;
  startedAt: Date;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export interface DlqEntry {
  jobId: string;
  endpointUrl: string;
  executionCount: number;
  retryBudget: number;
  lastAttempts: DlqAttemptBody[];
}

export interface DlqSummary {
  count: number;
  entries: DlqEntry[];
}

function toAttemptBody(attempt: DeliveryAttempt): DlqAttemptBody {
  return {
    deliveryJobId: attempt.deliveryJobId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    responseStatus: attempt.responseStatus,
    responseLatencyMs: attempt.responseLatencyMs,
    errorBody: attempt.errorBody,
  };
}

// Failed executions used against the retry budget. The RPC appends one attempt
// row per state transition, so raw row counts would burn the budget several
// times as fast: only "failed" rows count, one per failed execution, which
// keeps parity with the legacy jobs.retry_count. delivery_attempts starts at
// the cutover, so retry_count is the floor for jobs with pre-cutover history
// or no attempt rows.
function countExecutions(job: JobRecord, history: readonly DeliveryAttempt[]): number {
  const failedRows = history.filter((attempt) => attempt.status === "failed").length;
  return Math.max(job.retryCount, failedRows);
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc,
    private readonly retryBudget: DeliveryRetryBudget = new DeliveryRetryBudget(),
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

  markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attempts.markRunning(jobId, workerId);
  }

  markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.markFailed(jobId, errorMessage, details);
  }

  markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.markCompleted(jobId, details);
  }

  retry(jobId: string): Promise<JobRecord> {
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

  // UI status: the latest attempt's status, or "stuck" when that attempt has
  // been running longer than STUCK_AFTER_MS. Jobs without attempt rows (new,
  // pre-cutover, non-pilot, or rolled back) keep reading jobs.status.
  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<DisplayStatus> {
    const latest = await this.attempts.latestAttempt(job);
    if (!latest) {
      return job.status;
    }

    if (
      latest.status === "running" &&
      now.getTime() - latest.startedAt.getTime() > STUCK_AFTER_MS
    ) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }

  // A dispatch job is DLQ-bound once its latest outcome is failed and it has
  // used its account's whole retry budget. Null for every other job.
  async dlqEntry(job: JobRecord): Promise<DlqEntry | null> {
    if (job.type !== "dispatch_webhook") {
      return null;
    }

    const [status, history] = await Promise.all([
      this.displayStatus(job),
      this.attempts.attemptHistory(job),
    ]);
    if (status !== "failed") {
      return null;
    }

    const executionCount = countExecutions(job, history);
    const retryBudget = this.retryBudget.forAccount(job.accountId);
    if (executionCount < retryBudget) {
      return null;
    }

    return {
      jobId: job.id,
      endpointUrl: job.metadata.endpointUrl,
      executionCount,
      retryBudget,
      lastAttempts: history
        .filter((attempt) => OUTCOME_STATUSES.has(attempt.status))
        .slice(0, DLQ_LAST_ATTEMPTS)
        .map(toAttemptBody),
    };
  }

  async dlqSummary(jobs: readonly JobRecord[]): Promise<DlqSummary> {
    const entries = (await Promise.all(jobs.map((job) => this.dlqEntry(job)))).filter(
      (entry): entry is DlqEntry => entry !== null,
    );
    return { count: entries.length, entries };
  }

  // drain_dlq processor: moves a past-budget dispatch job to the Dead Letter
  // Queue by recording a drain_dlq job for its intent. The drain job reuses
  // the dispatch metadata, so its endpoint is metadata.endpointUrl, and its
  // execution is written through the RPC like any other job. Returns null
  // when the job is not past its budget.
  async drainDlq(job: JobRecord, workerId: string): Promise<JobRecord | null> {
    const entry = await this.dlqEntry(job);
    if (!entry) {
      return null;
    }

    const drainJob = await this.ensureJobRecord({
      accountId: job.accountId,
      briefId: job.briefId,
      taskId: job.taskId,
      parentJobId: job.id,
      type: "drain_dlq",
      metadata: job.metadata,
    });
    if (drainJob.status === "running" || drainJob.status === "completed") {
      return drainJob;
    }

    await this.markRunning(drainJob.id, workerId);
    return this.markCompleted(drainJob.id, { workerId });
  }
}
