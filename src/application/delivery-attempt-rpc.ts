import type { CreateDeliveryAttemptInput, DeliveryAttempt } from "../domain/delivery-attempt";
import { DuplicateAttemptError, JobNotFoundError } from "../domain/errors";
import type { JobExecutionDetails, JobRecord } from "../domain/job";
import type { DeliveryStore } from "../domain/job-repository";
import {
  envDeliveryAttemptFlags,
  type DeliveryAttemptFlagSource,
} from "./delivery-attempt-flags";

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class DeliveryAttemptRpc {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: DeliveryStore,
    private readonly flags: DeliveryAttemptFlagSource = envDeliveryAttemptFlags,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (this.flags.isRollbackEnabled()) {
      return this.store.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId },
      });
    }

    await this.appendAttempt(jobId, {
      deliveryJobId: jobId,
      attemptNumber: 0,
      workerId,
      status: "running",
      startedAt: new Date(),
    });

    return this.store.updateExecution(jobId, {
      status: "running",
      workerId,
      details: { workerId },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (this.flags.isRollbackEnabled()) {
      return this.store.updateExecution(jobId, {
        status: "failed",
        errorMessage,
        details,
      });
    }

    await this.appendAttempt(jobId, {
      deliveryJobId: jobId,
      attemptNumber: 0,
      workerId: details?.workerId,
      status: "failed",
      responseStatus: details?.responseStatus,
      responseLatencyMs: details?.responseLatencyMs,
      errorBody: details?.errorBody ?? errorMessage,
      completedAt: new Date(),
    });

    return this.store.updateExecution(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (this.flags.isRollbackEnabled()) {
      return this.store.updateExecution(jobId, {
        status: "completed",
        details,
      });
    }

    await this.appendAttempt(jobId, {
      deliveryJobId: jobId,
      attemptNumber: 0,
      workerId: details.workerId,
      status: "completed",
      responseStatus: details.responseStatus,
      responseLatencyMs: details.responseLatencyMs,
      errorBody: details.errorBody,
      completedAt: new Date(),
    });

    return this.store.updateExecution(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    await this.requireJob(jobId);

    if (this.flags.isRollbackEnabled()) {
      return this.store.incrementRetry(jobId);
    }

    await this.appendAttempt(jobId, {
      deliveryJobId: jobId,
      attemptNumber: 0,
      status: "queued",
      errorBody: "retry scheduled",
    });

    return this.store.incrementRetry(jobId);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttempt[]> {
    return this.store.listAttempts(jobId);
  }

  async latestAttempt(jobId: string): Promise<DeliveryAttempt | null> {
    const attempts = await this.store.listAttempts(jobId);
    return attempts.reduce<DeliveryAttempt | null>((latest, attempt) => {
      if (!latest || attempt.attemptNumber > latest.attemptNumber) {
        return attempt;
      }

      return latest;
    }, null);
  }

  async displayStatus(job: JobRecord): Promise<string> {
    if (this.flags.isRollbackEnabled()) {
      return job.status ?? "queued";
    }

    const latest = await this.latestAttempt(job.id);
    if (!latest) {
      return "queued";
    }

    if (
      latest.status === "running" &&
      latest.startedAt !== undefined &&
      this.now().getTime() - latest.startedAt.getTime() > STUCK_AFTER_MS
    ) {
      return "stuck";
    }

    return latest.status;
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const existing = await this.store.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return existing;
  }

  private enqueue<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(jobId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.tails.set(
      jobId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private appendAttempt(jobId: string, input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    return this.enqueue(jobId, () => this.insertMonotonicAttempt(input));
  }

  private async insertMonotonicAttempt(
    input: CreateDeliveryAttemptInput,
  ): Promise<DeliveryAttempt> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.store.listAttempts(input.deliveryJobId);
      const attemptNumber = existing.reduce((max, row) => Math.max(max, row.attemptNumber), 0) + 1;

      try {
        return await this.store.insertAttempt({
          ...input,
          attemptNumber,
        });
      } catch (error) {
        if (error instanceof DuplicateAttemptError) {
          continue;
        }

        throw error;
      }
    }

    throw new DuplicateAttemptError(input.deliveryJobId, input.attemptNumber);
  }
}
