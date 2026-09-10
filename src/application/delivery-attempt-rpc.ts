import { DuplicateAttemptError, JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  DeliveryAttempt,
  JobExecutionDetails,
  JobRecord,
  JobStatus,
  UpdateJobExecutionInput,
} from "../domain/job";
import {
  DELIVERY_ATTEMPTS_ROLLBACK_FLAG,
  EnvFeatureFlagStore,
  type FeatureFlagStore,
} from "./feature-flags";

const ATTEMPT_NUMBER_RETRIES = 16;

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly flags: FeatureFlagStore = new EnvFeatureFlagStore(),
  ) {}

  isRollbackEnabled(): boolean {
    return this.flags.isEnabled(DELIVERY_ATTEMPTS_ROLLBACK_FLAG);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.execute(jobId, {
      status: "running",
      workerId,
      details: { workerId },
      attempt: {
        status: "running",
        workerId,
        startedAt: new Date(),
      },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.execute(jobId, {
      status: "failed",
      errorMessage,
      details,
      attempt: {
        status: "failed",
        workerId: details?.workerId,
        responseStatus: details?.responseStatus,
        responseLatencyMs: details?.responseLatencyMs,
        errorBody: details?.errorBody ?? errorMessage,
        startedAt: new Date(),
      },
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.execute(jobId, {
      status: "completed",
      details,
      attempt: {
        status: "completed",
        workerId: details.workerId,
        responseStatus: details.responseStatus,
        responseLatencyMs: details.responseLatencyMs,
        errorBody: details.errorBody,
        startedAt: new Date(),
      },
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (!this.isRollbackEnabled()) {
      await this.insertMonotonicAttempt(jobId, {
        status: "queued",
        startedAt: new Date(),
      });
    }

    return this.jobs.incrementRetry(jobId);
  }

  private async execute(
    jobId: string,
    input: UpdateJobExecutionInput & {
      attempt: {
        status: JobStatus;
        workerId?: string | undefined;
        responseStatus?: number | undefined;
        responseLatencyMs?: number | undefined;
        errorBody?: string | undefined;
        startedAt?: Date | undefined;
      };
    },
  ): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (!this.isRollbackEnabled()) {
      await this.insertMonotonicAttempt(jobId, input.attempt);
    }

    return this.jobs.updateExecution(jobId, {
      status: input.status,
      workerId: input.workerId,
      errorMessage: input.errorMessage,
      details: input.details,
    });
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return existing;
  }

  private async insertMonotonicAttempt(
    jobId: string,
    input: {
      status: JobStatus;
      workerId?: string | undefined;
      responseStatus?: number | undefined;
      responseLatencyMs?: number | undefined;
      errorBody?: string | undefined;
      startedAt?: Date | undefined;
    },
  ): Promise<DeliveryAttempt> {
    for (let attempt = 0; attempt < ATTEMPT_NUMBER_RETRIES; attempt += 1) {
      const attemptNumber = await this.nextAttemptNumber(jobId);
      try {
        return await this.jobs.insertAttempt({
          deliveryJobId: jobId,
          attemptNumber,
          workerId: input.workerId,
          status: input.status,
          responseStatus: input.responseStatus,
          responseLatencyMs: input.responseLatencyMs,
          errorBody: input.errorBody,
          startedAt: input.startedAt,
        });
      } catch (error) {
        if (error instanceof DuplicateAttemptError) {
          continue;
        }
        throw error;
      }
    }

    throw new Error(`failed to allocate attempt_number for ${jobId}`);
  }

  private async nextAttemptNumber(jobId: string): Promise<number> {
    const existing = await this.jobs.listAttempts(jobId);
    const latest = existing[0];
    return (latest?.attemptNumber ?? 0) + 1;
  }
}
