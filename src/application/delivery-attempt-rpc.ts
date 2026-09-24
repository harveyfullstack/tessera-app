import { AttemptNumberConflictError, JobNotFoundError, NoRunningAttemptError } from "../domain/errors";
import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { DeliveryRollbackFlag } from "../domain/delivery-rollback-flag";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord, JobStatus } from "../domain/job";

// Upper bound on attempt_number conflicts one markRunning call will absorb
// before surfacing the unique-index violation.
const MAX_ATTEMPT_NUMBER_CONFLICTS = 10;

interface AttemptOutcome {
  status: "completed" | "failed";
  errorBody?: string | undefined;
  details?: JobExecutionDetails | undefined;
}

// Where a job's execution state lives for its account: the legacy jobs row
// when the rollback flag is on, otherwise the latest delivery_attempts row.
export type ExecutionState =
  | { source: "jobs"; status: JobStatus }
  | { source: "attempts"; latest: DeliveryAttempt | null };

// Single write boundary for delivery execution state, and the only place the
// per-account rollback flag is read. With the flag off, each execution is one
// delivery_attempts row: inserted as running, finished once. With the flag on,
// writes keep the legacy mutable jobs-row behavior.
export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly rollbackFlag: DeliveryRollbackFlag,
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (await this.rollbackFlag.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId },
      });
    }

    await this.insertNextAttempt(jobId, workerId);
    return this.projectLatestAttempt(job);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (await this.rollbackFlag.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, { status: "failed", errorMessage, details });
    }

    await this.finishRunningAttempt(jobId, {
      status: "failed",
      errorBody: details?.errorBody ?? errorMessage,
      details,
    });
    // error_body keeps the endpoint response for DLQ history, but the returned
    // record keeps the caller's message so the API payload is unchanged.
    return { ...(await this.projectLatestAttempt(job)), errorMessage };
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (await this.rollbackFlag.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(jobId, { status: "completed", details });
    }

    await this.finishRunningAttempt(jobId, {
      status: "completed",
      errorBody: details.errorBody,
      details,
    });
    return this.projectLatestAttempt(job);
  }

  // No attempt row is written here: the next markRunning creates the next
  // attempt.
  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    if (await this.rollbackFlag.isRollbackEnabled(job.accountId)) {
      return this.jobs.incrementRetry(jobId);
    }

    return this.projectLatestAttempt(job);
  }

  // Read side of the same flag decision the writes above make, so callers
  // never read the rollback flag themselves.
  async readExecutionState(job: JobRecord): Promise<ExecutionState> {
    if (await this.rollbackFlag.isRollbackEnabled(job.accountId)) {
      return { source: "jobs", status: job.status };
    }

    return { source: "attempts", latest: await this.attempts.findLatestByJob(job.id) };
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  // attempt_number is MAX + 1, computed here. Racing callers can read the same
  // MAX; the unique index rejects all but one and the losers re-read.
  private async insertNextAttempt(jobId: string, workerId: string): Promise<DeliveryAttempt> {
    for (let conflicts = 0; ; conflicts += 1) {
      const existing = await this.attempts.listByJob(jobId);
      const attemptNumber = (existing.at(-1)?.attemptNumber ?? 0) + 1;
      try {
        return await this.attempts.insert({
          deliveryJobId: jobId,
          attemptNumber,
          workerId,
          status: "running",
        });
      } catch (error) {
        const retryable =
          error instanceof AttemptNumberConflictError &&
          conflicts < MAX_ATTEMPT_NUMBER_CONFLICTS;
        if (!retryable) {
          throw error;
        }
      }
    }
  }

  private async finishRunningAttempt(
    jobId: string,
    outcome: AttemptOutcome,
  ): Promise<DeliveryAttempt> {
    const existing = await this.attempts.listByJob(jobId);
    const running = latestRunning(existing);
    if (!running) {
      throw new NoRunningAttemptError(jobId);
    }

    return this.attempts.update({
      ...running,
      status: outcome.status,
      responseStatus: outcome.details?.responseStatus,
      responseLatencyMs: outcome.details?.responseLatencyMs,
      errorBody: outcome.errorBody,
      completedAt: new Date(),
    });
  }

  // Keeps the JobRecord return shape: intent from the job, execution state
  // from the latest attempt. retryCount is chosen so the migration's
  // legacy_job_attempt_count() of the projected row equals the attempt count.
  private async projectLatestAttempt(job: JobRecord): Promise<JobRecord> {
    const existing = await this.attempts.listByJob(job.id);
    const latest = existing.at(-1);
    if (!latest) {
      return job;
    }

    const attemptCount = existing.length;
    return {
      ...job,
      status: latest.status,
      workerId: latest.workerId,
      errorMessage: latest.errorBody,
      retryCount: latest.status === "failed" ? attemptCount : attemptCount - 1,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
      updatedAt: latest.completedAt ?? latest.startedAt,
    };
  }
}

function latestRunning(attempts: readonly DeliveryAttempt[]): DeliveryAttempt | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt?.status === "running") {
      return attempt;
    }
  }
  return undefined;
}
