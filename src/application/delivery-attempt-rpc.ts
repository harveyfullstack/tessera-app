import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttempt, DeliveryAttemptStatus } from "../domain/delivery-attempt";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { DeliveryRollbackFlag } from "../domain/delivery-rollback-flag";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord } from "../domain/job";

export interface DeliveryAttemptWrite {
  job: JobRecord;
  attempt: DeliveryAttempt;
}

interface AttemptTransition {
  status: DeliveryAttemptStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

/**
 * The single write boundary for delivery execution state (TESSERA-1881).
 *
 * Every call appends one delivery_attempts row. attempt_number is computed
 * here, inside a per-job critical section, so racing callers always receive
 * strictly increasing numbers; the repository's (delivery_job_id,
 * attempt_number) uniqueness is the backstop.
 *
 * This is also the only place the per-account rollback flag is read. While
 * an account's rollback window is open, the legacy execution columns on the
 * job row are dual-written exactly as before the split, which keeps the
 * old/new parity check (sql/checks/delivery_attempt_parity.sql) valid.
 *
 * Parity counts 'running' rows. markRunning writes 'running', markFailed and
 * markCompleted write the run's terminal row, and retry writes 'queued' (a
 * scheduled retry, not a run), so a run is still exactly one 'running' row.
 */
export class DeliveryAttemptRpc {
  private readonly jobLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly rollbackFlag: DeliveryRollbackFlag,
  ) {}

  markRunning(jobId: string, workerId: string): Promise<DeliveryAttemptWrite> {
    return this.record(jobId, { status: "running", workerId }, () =>
      this.jobs.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId },
      }),
    );
  }

  markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<DeliveryAttemptWrite> {
    return this.record(
      jobId,
      {
        status: "failed",
        workerId: details?.workerId,
        responseStatus: details?.responseStatus,
        responseLatencyMs: details?.responseLatencyMs,
        errorBody: details?.errorBody ?? errorMessage,
      },
      () =>
        this.jobs.updateExecution(jobId, {
          status: "failed",
          errorMessage,
          details,
        }),
    );
  }

  markCompleted(jobId: string, details: JobExecutionDetails): Promise<DeliveryAttemptWrite> {
    return this.record(
      jobId,
      {
        status: "completed",
        workerId: details.workerId,
        responseStatus: details.responseStatus,
        responseLatencyMs: details.responseLatencyMs,
      },
      () =>
        this.jobs.updateExecution(jobId, {
          status: "completed",
          details,
        }),
    );
  }

  retry(jobId: string): Promise<DeliveryAttemptWrite> {
    return this.record(jobId, { status: "queued" }, () => this.jobs.incrementRetry(jobId));
  }

  private record(
    jobId: string,
    transition: AttemptTransition,
    writeLegacyColumns: () => Promise<JobRecord>,
  ): Promise<DeliveryAttemptWrite> {
    return this.withJobLock(jobId, async () => {
      const job = await this.jobs.findById(jobId);
      if (!job) {
        throw new JobNotFoundError(jobId);
      }

      const dualWriteLegacy = await this.rollbackFlag.isRollbackWindowOpen(job.accountId);
      const history = await this.attempts.listByJob(jobId);
      const attempt = await this.attempts.append({
        ...transition,
        deliveryJobId: jobId,
        attemptNumber: nextAttemptNumber(history),
        startedAt: attemptStartedAt(transition.status, history),
      });

      const updatedJob = dualWriteLegacy ? await writeLegacyColumns() : job;
      return { job: updatedJob, attempt };
    });
  }

  private withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(jobId) ?? Promise.resolve();
    const result = previous.then(work);
    const released = result.then(
      () => undefined,
      () => undefined,
    );

    this.jobLocks.set(jobId, released);
    void released.then(() => {
      if (this.jobLocks.get(jobId) === released) {
        this.jobLocks.delete(jobId);
      }
    });

    return result;
  }
}

function nextAttemptNumber(history: readonly DeliveryAttempt[]): number {
  return history.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1;
}

// A run's terminal row carries the started_at of the 'running' row that
// opened it, matching the migration 002 backfill. Queued rows have none.
function attemptStartedAt(
  status: DeliveryAttemptStatus,
  history: readonly DeliveryAttempt[],
): Date | undefined {
  if (status === "running") {
    return new Date();
  }
  if (status === "queued") {
    return undefined;
  }

  const openingRun = [...history].reverse().find((attempt) => attempt.status === "running");
  return openingRun?.startedAt;
}
