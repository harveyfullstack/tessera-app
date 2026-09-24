import { randomUUID } from "crypto";
import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type { DeliveryJobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  JobExecutionDetails,
  JobRecord,
} from "../domain/job";

export type RepositoryWithDelivery = JobRepository & Partial<DeliveryJobRepository>;

export class DeliveryAttemptRpc {
  private rollbackFlagGlobal = false;
  private readonly rollbackPerAccount = new Map<string, boolean>();
  private readonly jobLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly jobs: RepositoryWithDelivery) {}

  // Rollback feature flag management
  isRollbackActive(accountId?: string): boolean {
    if (accountId && this.rollbackPerAccount.has(accountId)) {
      return this.rollbackPerAccount.get(accountId)!;
    }
    return this.rollbackFlagGlobal;
  }

  setRollbackFlag(enabled: boolean): void {
    this.rollbackFlagGlobal = enabled;
  }

  setRollbackFlagForAccount(accountId: string, enabled: boolean): void {
    this.rollbackPerAccount.set(accountId, enabled);
  }

  clearRollbackFlagForAccount(accountId: string): void {
    this.rollbackPerAccount.delete(accountId);
  }

  // Serialized execution per job to guarantee monotonically increasing attempt_number
  private async runSerialized<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.jobLocks.get(jobId) ?? Promise.resolve();
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockWait = current.then(() => fn());
    this.jobLocks.set(
      jobId,
      lockWait.finally(() => releaseLock()),
    );

    try {
      return await lockWait;
    } finally {
      if (this.jobLocks.get(jobId) === lockWait) {
        this.jobLocks.delete(jobId);
      }
    }
  }

  private isDeliveryRepo(
    repo: RepositoryWithDelivery,
  ): repo is JobRepository & DeliveryJobRepository {
    return (
      typeof (repo as DeliveryJobRepository).createDeliveryAttempt === "function" &&
      typeof (repo as DeliveryJobRepository).getLatestDeliveryAttempt === "function"
    );
  }

  private async getNextAttemptNumber(jobId: string): Promise<number> {
    if (!this.isDeliveryRepo(this.jobs)) {
      return 1;
    }
    const latest = await this.jobs.getLatestDeliveryAttempt(jobId);
    return latest ? latest.attemptNumber + 1 : 1;
  }

  private async ensureDeliveryJobIntent(job: JobRecord): Promise<string> {
    if (!this.isDeliveryRepo(this.jobs)) {
      return job.id;
    }
    const existing = await this.jobs.findDeliveryJob(job.accountId, job.briefId, job.type);
    if (existing) {
      return existing.id;
    }
    const created = await this.jobs.createDeliveryJob({
      ...({ id: job.id } as unknown as CreateJobInput),
      accountId: job.accountId,
      briefId: job.briefId,
      taskId: job.taskId,
      parentJobId: job.parentJobId,
      type: job.type,
      metadata: job.metadata,
    });
    return created.id;
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.runSerialized(jobId, async () => {
      const existing = await this.jobs.findById(jobId);
      if (!existing) {
        throw new JobNotFoundError(jobId);
      }

      // Check rollback feature flag as single boundary
      if (this.isRollbackActive(existing.accountId)) {
        return this.jobs.updateExecution(jobId, {
          status: "running",
          workerId,
          details: { workerId },
        });
      }

      // Phase 2 execution write: insert delivery_attempts row
      const deliveryJobId = await this.ensureDeliveryJobIntent(existing);
      const attemptNumber = await this.getNextAttemptNumber(deliveryJobId);
      const now = new Date();

      if (this.isDeliveryRepo(this.jobs)) {
        await this.jobs.createDeliveryAttempt({
          deliveryJobId,
          attemptNumber,
          workerId,
          status: "running",
          startedAt: now,
        });
      }

      return this.jobs.updateExecution(jobId, {
        status: "running",
        workerId,
        details: { workerId, attemptNumber },
      });
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.runSerialized(jobId, async () => {
      const existing = await this.jobs.findById(jobId);
      if (!existing) {
        throw new JobNotFoundError(jobId);
      }

      // Check rollback feature flag as single boundary
      if (this.isRollbackActive(existing.accountId)) {
        return this.jobs.updateExecution(jobId, {
          status: "failed",
          errorMessage,
          details,
        });
      }

      // Phase 2 execution write: insert delivery_attempts row
      const deliveryJobId = await this.ensureDeliveryJobIntent(existing);
      const attemptNumber = await this.getNextAttemptNumber(deliveryJobId);
      const now = new Date();

      if (this.isDeliveryRepo(this.jobs)) {
        await this.jobs.createDeliveryAttempt({
          deliveryJobId,
          attemptNumber,
          workerId: details?.workerId ?? existing.workerId,
          status: "failed",
          errorBody: errorMessage,
          responseStatus: details?.responseStatus,
          responseLatencyMs: details?.responseLatencyMs,
          completedAt: now,
        });
      }

      return this.jobs.updateExecution(jobId, {
        status: "failed",
        errorMessage,
        details: { ...details, attemptNumber },
      });
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.runSerialized(jobId, async () => {
      const existing = await this.jobs.findById(jobId);
      if (!existing) {
        throw new JobNotFoundError(jobId);
      }

      // Check rollback feature flag as single boundary
      if (this.isRollbackActive(existing.accountId)) {
        return this.jobs.updateExecution(jobId, {
          status: "completed",
          details,
        });
      }

      // Phase 2 execution write: insert delivery_attempts row
      const deliveryJobId = await this.ensureDeliveryJobIntent(existing);
      const attemptNumber = await this.getNextAttemptNumber(deliveryJobId);
      const now = new Date();

      if (this.isDeliveryRepo(this.jobs)) {
        await this.jobs.createDeliveryAttempt({
          deliveryJobId,
          attemptNumber,
          workerId: details.workerId ?? existing.workerId,
          status: "completed",
          responseStatus: details.responseStatus ?? 200,
          responseLatencyMs: details.responseLatencyMs,
          completedAt: now,
        });
      }

      return this.jobs.updateExecution(jobId, {
        status: "completed",
        details: { ...details, attemptNumber },
      });
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.runSerialized(jobId, async () => {
      const existing = await this.jobs.findById(jobId);
      if (!existing) {
        throw new JobNotFoundError(jobId);
      }

      // Check rollback feature flag as single boundary
      if (this.isRollbackActive(existing.accountId)) {
        return this.jobs.incrementRetry(jobId);
      }

      // Phase 2 execution write: insert delivery_attempts row
      const deliveryJobId = await this.ensureDeliveryJobIntent(existing);
      const attemptNumber = await this.getNextAttemptNumber(deliveryJobId);
      const now = new Date();

      if (this.isDeliveryRepo(this.jobs)) {
        await this.jobs.createDeliveryAttempt({
          deliveryJobId,
          attemptNumber,
          workerId: existing.workerId,
          status: "queued",
          startedAt: now,
        });
      }

      return this.jobs.incrementRetry(jobId);
    });
  }
}
