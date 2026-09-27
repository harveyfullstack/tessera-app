import { randomUUID } from "crypto";
import { JobNotFoundError } from "../domain/errors";
import type {
  DeliveryAttemptRecord,
  DeliveryAttemptStore,
} from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type {
  JobExecutionDetails,
  JobRecord,
  JobStatus,
} from "../domain/job";
import { InMemoryDeliveryAttemptStore } from "../infrastructure/repositories/in-memory-delivery-attempt-store";

export interface DeliveryAttemptRpcOptions {
  /**
   * Accounts in rollback use the legacy mutable job projection. The decision
   * is intentionally made here so callers cannot bypass the account gate.
   */
  rollbackEnabledForAccount?: (accountId: string) => boolean;
  attemptStore?: DeliveryAttemptStore;
}

export interface DeliveryAttemptInput {
  status: Exclude<JobStatus, "queued">;
  workerId?: string | undefined;
  errorMessage?: string | undefined;
  details?: JobExecutionDetails | undefined;
}

export class DeliveryAttemptRpc {
  private static readonly maxErrorBodyLength = 16_384;
  private readonly store: DeliveryAttemptStore;
  private readonly nextAttemptByJob = new Map<string, Promise<number>>();
  private readonly rollbackEnabledForAccount: (accountId: string) => boolean;

  constructor(
    private readonly jobs: JobRepository,
    options: DeliveryAttemptRpcOptions = {},
  ) {
    this.store = options.attemptStore ?? new InMemoryDeliveryAttemptStore();
    this.rollbackEnabledForAccount =
      options.rollbackEnabledForAccount ?? (() => false);
  }

  isRollbackEnabledForAccount(accountId: string): boolean {
    return this.rollbackEnabledForAccount(accountId);
  }

  async record(jobId: string, input: DeliveryAttemptInput): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (input.details?.errorBody && input.details.errorBody.length > DeliveryAttemptRpc.maxErrorBodyLength) {
      throw new Error("delivery attempt error body exceeds 16384 characters");
    }

    if (this.rollbackEnabledForAccount(job.accountId)) {
      return this.jobs.updateExecution(jobId, input);
    }

    if (input.status !== "running") {
      const attempts = await this.store.listByJob(jobId);
      const latest = attempts[attempts.length - 1];
      if (latest?.status === "running") {
        await this.store.updateLatest(jobId, {
          status: input.status,
          errorMessage: input.errorMessage,
          details: { ...input.details, attemptNumber: latest.attemptNumber },
          completedAt: new Date(),
        });
        return this.jobs.updateExecution(jobId, input);
      }
      throw new Error(`no running delivery attempt for job ${jobId}`);
    }

    const attemptNumber = await this.allocateAttemptNumber(jobId);
    const now = new Date();
    const attempt: DeliveryAttemptRecord = {
      id: randomUUID(),
      deliveryJobId: jobId,
      attemptNumber,
      status: input.status,
      workerId: input.workerId,
      errorMessage: input.errorMessage,
      details: { ...input.details, attemptNumber },
      startedAt: now,
      completedAt:
        input.status === "running" ? undefined : now,
    };

    await this.store.insert(attempt);
    return this.jobs.updateExecution(jobId, {
      ...input,
      details: attempt.details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (this.rollbackEnabledForAccount(job.accountId)) {
      return this.jobs.incrementRetry(jobId);
    }

    return this.jobs.incrementRetry(jobId);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]> {
    return this.store.listByJob(jobId);
  }

  private async allocateAttemptNumber(jobId: string): Promise<number> {
    const previous = this.nextAttemptByJob.get(jobId) ?? Promise.resolve(0);
    const next = previous.then(async (last) => {
      const attempts = await this.store.listByJob(jobId);
      return Math.max(last, attempts[attempts.length - 1]?.attemptNumber ?? 0) + 1;
    });
    this.nextAttemptByJob.set(jobId, next);
    return next;
  }
}
