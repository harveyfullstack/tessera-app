import {
  AttemptNumberConflictError,
  AttemptNumberContentionError,
  PilotAccountLimitError,
} from "../domain/errors";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { DeliveryAttempt, InsertDeliveryAttemptInput } from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord } from "../domain/job";

export const MAX_PILOT_ACCOUNTS = 3;
const MAX_ATTEMPT_NUMBER_TRIES = 5;

/**
 * Per-account gate for the intent/attempt split. Account ids are added at
 * rollout; a rollback entry forces the legacy path and wins over the pilot list.
 */
export interface DeliverySplitFlags {
  pilotAccountIds: ReadonlySet<string>;
  rollbackAccountIds: ReadonlySet<string>;
}

export const EMPTY_DELIVERY_SPLIT_FLAGS: DeliverySplitFlags = {
  pilotAccountIds: new Set<string>(),
  rollbackAccountIds: new Set<string>(),
};

type AttemptFields = Omit<InsertDeliveryAttemptInput, "deliveryJobId" | "attemptNumber">;

/**
 * Single boundary for delivery execution writes and the only place the
 * per-account split flag is checked.
 *
 * Legacy path: mutate the jobs row only.
 * Split path: append one delivery_attempts row per call, then mirror the
 * write onto the jobs row so the rollback (which reads jobs.status) stays
 * executable.
 */
export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly flags: DeliverySplitFlags = EMPTY_DELIVERY_SPLIT_FLAGS,
  ) {
    if (flags.pilotAccountIds.size > MAX_PILOT_ACCOUNTS) {
      throw new PilotAccountLimitError(MAX_PILOT_ACCOUNTS, flags.pilotAccountIds.size);
    }
  }

  usesAttemptPath(accountId: string): boolean {
    if (this.flags.rollbackAccountIds.has(accountId)) {
      return false;
    }
    return this.flags.pilotAccountIds.has(accountId);
  }

  /**
   * Highest-numbered attempt for the job, or null when the job was never
   * mapped to a delivery intent or has no attempt rows. Does not check the
   * split flag; callers decide whether attempts are authoritative.
   */
  async latestAttempt(job: JobRecord): Promise<DeliveryAttempt | null> {
    if (!job.deliveryJobId) {
      return null;
    }
    const rows = await this.attempts.listAttempts(job.deliveryJobId);
    return rows[rows.length - 1] ?? null;
  }

  async markRunning(job: JobRecord, workerId: string): Promise<JobRecord> {
    return this.write(job, { status: "running", workerId }, () =>
      this.jobs.updateExecution(job.id, {
        status: "running",
        workerId,
        details: { workerId },
      }),
    );
  }

  async markFailed(
    job: JobRecord,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const attempt: AttemptFields = {
      status: "failed",
      workerId: details?.workerId,
      responseStatus: details?.responseStatus,
      responseLatencyMs: details?.responseLatencyMs,
      errorBody: details?.errorBody ?? errorMessage,
    };
    return this.write(job, attempt, () =>
      this.jobs.updateExecution(job.id, {
        status: "failed",
        errorMessage,
        details,
      }),
    );
  }

  async markCompleted(job: JobRecord, details: JobExecutionDetails): Promise<JobRecord> {
    const attempt: AttemptFields = {
      status: "completed",
      workerId: details.workerId,
      responseStatus: details.responseStatus,
      responseLatencyMs: details.responseLatencyMs,
      errorBody: details.errorBody,
    };
    return this.write(job, attempt, () =>
      this.jobs.updateExecution(job.id, {
        status: "completed",
        details,
      }),
    );
  }

  async retry(job: JobRecord): Promise<JobRecord> {
    return this.write(job, { status: "queued" }, () => this.jobs.incrementRetry(job.id));
  }

  private async write(
    job: JobRecord,
    attempt: AttemptFields,
    legacyWrite: () => Promise<JobRecord>,
  ): Promise<JobRecord> {
    if (this.usesAttemptPath(job.accountId)) {
      await this.append(job, attempt);
    }
    return legacyWrite();
  }

  private async append(job: JobRecord, attempt: AttemptFields): Promise<DeliveryAttempt> {
    const deliveryJobId = await this.resolveDeliveryJobId(job);

    // Racing callers can read the same latest number; the unique
    // (delivery_job_id, attempt_number) key rejects the loser, which re-reads.
    for (let tries = 0; tries < MAX_ATTEMPT_NUMBER_TRIES; tries += 1) {
      const attemptNumber = (await this.attempts.latestAttemptNumber(deliveryJobId)) + 1;
      try {
        return await this.attempts.insertAttempt({ ...attempt, deliveryJobId, attemptNumber });
      } catch (error) {
        if (!(error instanceof AttemptNumberConflictError)) {
          throw error;
        }
      }
    }

    throw new AttemptNumberContentionError(deliveryJobId, MAX_ATTEMPT_NUMBER_TRIES);
  }

  private async resolveDeliveryJobId(job: JobRecord): Promise<string> {
    if (job.deliveryJobId) {
      return job.deliveryJobId;
    }

    // Post-migration jobs rows start unmapped. Resolve (or create) the
    // canonical intent, preferring the jobs id as the backfill does.
    const deliveryJob = await this.attempts.ensureDeliveryJob({
      id: job.id,
      accountId: job.accountId,
      briefId: job.briefId,
      taskId: job.taskId,
      type: job.type,
      metadata: job.metadata,
    });
    await this.jobs.linkDeliveryJob(job.id, deliveryJob.id);
    return deliveryJob.id;
  }
}
