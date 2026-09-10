import type { DeliveryAttempt } from "../domain/delivery-attempt";
import { DuplicateDeliveryAttemptError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord, JobStatus } from "../domain/job";
import { DeliveryRollbackFlags } from "./delivery-rollback-flags";

export class DeliveryAttemptRpc {
  constructor(
    private readonly jobs: JobRepository,
    private readonly flags: DeliveryRollbackFlags,
  ) {}

  async markRunning(job: JobRecord, workerId: string): Promise<JobRecord> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(job.id, {
        status: "running",
        workerId,
        details: { workerId },
      });
    }

    await this.insertMonotonic(job.id, {
      status: "running",
      workerId,
      startedAt: new Date(),
    });

    return this.jobs.updateExecution(job.id, {
      status: "running",
      workerId,
      details: { workerId },
    });
  }

  async markFailed(
    job: JobRecord,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(job.id, {
        status: "failed",
        errorMessage,
        details,
      });
    }

    await this.insertMonotonic(job.id, {
      status: "failed",
      workerId: details?.workerId ?? job.workerId,
      responseStatus: details?.responseStatus,
      responseLatencyMs: details?.responseLatencyMs,
      errorBody: details?.errorBody ?? errorMessage,
    });

    return this.jobs.updateExecution(job.id, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(job: JobRecord, details: JobExecutionDetails): Promise<JobRecord> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.updateExecution(job.id, {
        status: "completed",
        details,
      });
    }

    await this.insertMonotonic(job.id, {
      status: "completed",
      workerId: details.workerId ?? job.workerId,
      responseStatus: details.responseStatus,
      responseLatencyMs: details.responseLatencyMs,
      errorBody: details.errorBody,
    });

    return this.jobs.updateExecution(job.id, {
      status: "completed",
      details,
    });
  }

  async retry(job: JobRecord): Promise<JobRecord> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.jobs.incrementRetry(job.id);
    }

    await this.insertMonotonic(job.id, {
      status: "queued",
      workerId: job.workerId,
    });

    return this.jobs.incrementRetry(job.id);
  }

  private async insertMonotonic(
    deliveryJobId: string,
    input: {
      status: JobStatus;
      workerId?: string | undefined;
      responseStatus?: number | undefined;
      responseLatencyMs?: number | undefined;
      errorBody?: string | undefined;
      startedAt?: Date | undefined;
    },
  ): Promise<DeliveryAttempt> {
    for (;;) {
      const latest = await this.jobs.getLatestAttempt(deliveryJobId);
      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;

      try {
        return await this.jobs.insertAttempt({
          deliveryJobId,
          attemptNumber,
          status: input.status,
          workerId: input.workerId,
          responseStatus: input.responseStatus,
          responseLatencyMs: input.responseLatencyMs,
          errorBody: input.errorBody,
          startedAt: input.startedAt,
        });
      } catch (error) {
        if (error instanceof DuplicateDeliveryAttemptError) {
          continue;
        }
        throw error;
      }
    }
  }
}
