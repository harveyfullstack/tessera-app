import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type {
  AppendDeliveryAttemptInput,
  DeliveryAttemptStatus,
  DeliveryWritePathFlags,
} from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord } from "../domain/job";

type AttemptFields = Omit<AppendDeliveryAttemptInput, "deliveryJobId">;

// Both sets ship empty. Account ids are supplied at rollout, never hardcoded.
export const EMPTY_DELIVERY_WRITE_PATH_FLAGS: DeliveryWritePathFlags = {
  pilotAccountIds: new Set<string>(),
  rollbackAccountIds: new Set<string>(),
};

function attemptFields(
  status: DeliveryAttemptStatus,
  details: JobExecutionDetails | undefined,
): AttemptFields {
  return {
    status,
    workerId: details?.workerId,
    responseStatus: details?.responseStatus,
    responseLatencyMs: details?.responseLatencyMs,
    errorBody: details?.errorBody,
  };
}

// The single boundary for execution writes and the only place the per-account
// write-path flag is evaluated.
export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptStore,
    private readonly flags: DeliveryWritePathFlags = EMPTY_DELIVERY_WRITE_PATH_FLAGS,
  ) {}

  usesAttemptPath(accountId: string): boolean {
    // The rollback flag forces the legacy path and wins over the pilot list.
    if (this.flags.rollbackAccountIds.has(accountId)) {
      return false;
    }

    return this.flags.pilotAccountIds.has(accountId);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.record(jobId, attemptFields("running", { workerId }), () =>
      this.jobs.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId },
      }),
    );
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const attempt: AttemptFields = {
      ...attemptFields("failed", details),
      errorBody: details?.errorBody ?? errorMessage,
    };

    return this.record(jobId, attempt, () =>
      this.jobs.updateExecution(jobId, {
        status: "failed",
        errorMessage,
        details,
      }),
    );
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.record(jobId, attemptFields("completed", details), () =>
      this.jobs.updateExecution(jobId, {
        status: "completed",
        details,
      }),
    );
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.record(jobId, attemptFields("queued", undefined), () =>
      this.jobs.incrementRetry(jobId),
    );
  }

  private async record(
    jobId: string,
    attempt: AttemptFields,
    writeLegacy: () => Promise<JobRecord>,
  ): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (!this.usesAttemptPath(job.accountId)) {
      return writeLegacy();
    }

    const deliveryJobId = await this.linkIntent(job);
    await this.attempts.appendAttempt({ ...attempt, deliveryJobId });

    // jobs.status is still written so the 14-day rollback reads current state.
    return writeLegacy();
  }

  private async linkIntent(job: JobRecord): Promise<string> {
    if (job.deliveryJobId) {
      return job.deliveryJobId;
    }

    const intent = await this.attempts.ensureIntent(job);
    await this.jobs.linkDeliveryJob(job.id, intent.id);
    return intent.id;
  }
}
