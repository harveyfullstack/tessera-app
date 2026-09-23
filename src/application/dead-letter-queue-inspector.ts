import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRecord, JobStatus } from "../domain/job";
import type { RetryBudgetPolicy } from "./retry-budget-policy";

export const DLQ_ATTEMPT_BODY_LIMIT = 3;

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

// Read side only: execution writes go through DeliveryAttemptRpc.
export type DeliveryAttemptReader = Pick<DeliveryAttemptRepository, "listByJob">;

export interface DlqAttemptBody {
  // null when the body comes from the legacy jobs row, which has no attempt number.
  attemptNumber: number | null;
  status: JobStatus;
  responseStatus: number | null;
  // null for backfilled attempts, whose earlier error details were overwritten.
  errorBody: string | null;
  backfilled: boolean;
}

export interface DlqEndpoint {
  jobId: string;
  endpointUrl: string;
  runs: number;
  retryBudget: number;
  lastAttemptBodies: DlqAttemptBody[];
}

export interface DlqSummary {
  count: number;
  endpoints: DlqEndpoint[];
}

// Decides which webhook dispatch jobs are past their account's retry budget.
// Runs are counted from 'running' attempt rows (one per started run), never
// from MAX(attempt_number), which sequences every state transition. Jobs with
// no attempt rows fall back to the legacy retry_count columns.
export class DeadLetterQueueInspector {
  constructor(
    private readonly attempts: DeliveryAttemptReader,
    private readonly budgets: RetryBudgetPolicy,
  ) {}

  async evaluate(job: JobRecord): Promise<DlqEndpoint | null> {
    if (job.type !== "dispatch_webhook") {
      return null;
    }

    const attempts = await this.attempts.listByJob(job.id);
    const retryBudget = this.budgets.budgetFor(job.accountId);
    const runs = countRuns(job, attempts);

    if (runs < retryBudget || latestStatusOf(job, attempts) !== "failed") {
      return null;
    }

    return {
      jobId: job.id,
      endpointUrl: job.metadata.endpointUrl,
      runs,
      retryBudget,
      lastAttemptBodies: lastAttemptBodies(job, attempts),
    };
  }

  async summarize(jobs: readonly JobRecord[]): Promise<DlqSummary> {
    const evaluated = await Promise.all(jobs.map((job) => this.evaluate(job)));
    const endpoints = evaluated.filter((entry): entry is DlqEndpoint => entry !== null);
    return { count: endpoints.length, endpoints };
  }

  async latestStatus(job: JobRecord): Promise<JobStatus> {
    return latestStatusOf(job, await this.attempts.listByJob(job.id));
  }
}

function countRuns(job: JobRecord, attempts: readonly DeliveryAttempt[]): number {
  if (attempts.length > 0) {
    return attempts.filter((attempt) => attempt.status === "running").length;
  }
  return legacyRunCount(job);
}

// Mirrors delivery_jobs_legacy_attempt_count in
// sql/migrations/002_split_delivery_jobs_and_attempts.sql.
function legacyRunCount(job: JobRecord): number {
  if (!job.startedAt) {
    return 0;
  }
  if (job.status === "failed") {
    return Math.max(job.retryCount, 1);
  }
  return job.retryCount + 1;
}

function newestFirst(attempts: readonly DeliveryAttempt[]): DeliveryAttempt[] {
  return [...attempts].sort((a, b) => b.attemptNumber - a.attemptNumber);
}

// Status of the latest run. 'queued' rows are scheduled retries, not runs, and
// DeliveryOrchestrator writes one between a run's 'running' and 'failed' rows.
function latestStatusOf(job: JobRecord, attempts: readonly DeliveryAttempt[]): JobStatus {
  const latestRun = newestFirst(attempts).find((attempt) => attempt.status !== "queued");
  return latestRun?.status ?? job.status;
}

function lastAttemptBodies(
  job: JobRecord,
  attempts: readonly DeliveryAttempt[],
): DlqAttemptBody[] {
  if (attempts.length === 0) {
    return job.status === "failed" ? [legacyAttemptBody(job)] : [];
  }

  return newestFirst(attempts)
    .filter((attempt) => TERMINAL_STATUSES.has(attempt.status))
    .slice(0, DLQ_ATTEMPT_BODY_LIMIT)
    .map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      responseStatus: attempt.responseStatus ?? null,
      errorBody: attempt.errorBody ?? null,
      backfilled: attempt.backfilled,
    }));
}

// The legacy row keeps only the latest run's error; earlier ones were overwritten.
function legacyAttemptBody(job: JobRecord): DlqAttemptBody {
  return {
    attemptNumber: null,
    status: job.status,
    responseStatus: null,
    errorBody: job.errorMessage ?? null,
    backfilled: false,
  };
}
