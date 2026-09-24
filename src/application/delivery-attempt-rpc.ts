import { randomUUID } from "crypto";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type { DeliveryAttempt } from "../domain/delivery-schema";
import type { DeliveryRollbackFlags } from "../domain/delivery-rollback";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord, JobStatus } from "../domain/job";

interface AttemptWrite {
  status: JobStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export class DeliveryAttemptRpc {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptStore,
    private readonly flags: DeliveryRollbackFlags,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isRollbackEnabled(accountId: string): boolean {
    return this.flags.isRollbackEnabled(accountId);
  }

  async markRunning(job: JobRecord, workerId: string): Promise<JobRecord> {
    return this.exclusive(job.id, async () => {
      await this.record(job, { status: "running", workerId });
      return this.jobs.updateExecution(job.id, {
        status: "running",
        workerId,
        details: { workerId },
      });
    });
  }

  async markFailed(job: JobRecord, errorMessage: string, details?: JobExecutionDetails): Promise<JobRecord> {
    return this.exclusive(job.id, async () => {
      await this.record(job, {
        status: "failed",
        workerId: details?.workerId ?? job.workerId,
        responseStatus: details?.responseStatus,
        responseLatencyMs: details?.responseLatencyMs,
        errorBody: details?.errorBody ?? errorMessage,
      });
      return this.jobs.updateExecution(job.id, {
        status: "failed",
        errorMessage,
        ...(details !== undefined ? { details } : {}),
      });
    });
  }

  async markCompleted(job: JobRecord, details: JobExecutionDetails): Promise<JobRecord> {
    return this.exclusive(job.id, async () => {
      await this.record(job, {
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
    });
  }

  async retry(job: JobRecord): Promise<JobRecord> {
    return this.exclusive(job.id, async () => {
      await this.record(job, { status: "queued", workerId: job.workerId });
      return this.jobs.incrementRetry(job.id);
    });
  }

  private async record(job: JobRecord, write: AttemptWrite): Promise<void> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return;
    }

    const attempt = await this.nextAttempt(job.id, write);
    await this.attempts.insert(attempt);
  }

  private async nextAttempt(deliveryJobId: string, write: AttemptWrite): Promise<DeliveryAttempt> {
    const attemptNumber = await this.nextAttemptNumber(deliveryJobId);
    return {
      id: randomUUID(),
      deliveryJobId,
      attemptNumber,
      status: write.status,
      ...(write.workerId !== undefined ? { workerId: write.workerId } : {}),
      ...(write.responseStatus !== undefined ? { responseStatus: write.responseStatus } : {}),
      ...(write.responseLatencyMs !== undefined ? { responseLatencyMs: write.responseLatencyMs } : {}),
      ...(write.errorBody !== undefined ? { errorBody: write.errorBody } : {}),
      ...(write.status === "running" ? { startedAt: this.now() } : {}),
    };
  }

  private async nextAttemptNumber(deliveryJobId: string): Promise<number> {
    const rows = await this.attempts.list(deliveryJobId);
    return rows.reduce((max, row) => Math.max(max, row.attemptNumber), 0) + 1;
  }

  private async exclusive<T>(deliveryJobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(deliveryJobId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      deliveryJobId,
      previous.then(
        () => gate,
        () => gate,
      ),
    );
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
