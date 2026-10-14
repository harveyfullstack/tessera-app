import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { DeliveryAttempt, DeliveryAttemptWrite } from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type { JobExecutionDetails, JobRecord } from "../domain/job";
import type { DeliverySplitFlags } from "./delivery-split-flags";

// Single write boundary for delivery execution state and the only place the
// per-account split flag is checked. The legacy jobs row is always written so
// the 14-day rollback keeps reading jobs.status; split-enabled accounts also
// get one appended delivery_attempts row per call.
export class DeliveryAttemptRpc {
  private readonly appendQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly flags: DeliverySplitFlags,
  ) {}

  isSplitEnabled(accountId: string): boolean {
    return this.flags.isSplitEnabled(accountId);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    const updated = await this.jobs.updateExecution(jobId, {
      status: "running",
      workerId,
      details: { workerId },
    });

    await this.recordAttempt(job, { status: "running", workerId });
    return updated;
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    const updated = await this.jobs.updateExecution(jobId, {
      status: "failed",
      errorMessage,
      details,
    });

    await this.recordAttempt(job, {
      status: "failed",
      workerId: details?.workerId ?? updated.workerId,
      responseStatus: details?.responseStatus,
      responseLatencyMs: details?.responseLatencyMs,
      errorBody: details?.errorBody ?? errorMessage,
    });
    return updated;
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    const updated = await this.jobs.updateExecution(jobId, {
      status: "completed",
      details,
    });

    await this.recordAttempt(job, {
      status: "completed",
      workerId: details.workerId ?? updated.workerId,
      responseStatus: details.responseStatus,
      responseLatencyMs: details.responseLatencyMs,
      errorBody: details.errorBody,
    });
    return updated;
  }

  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.requireJob(jobId);
    const updated = await this.jobs.incrementRetry(jobId);

    await this.recordAttempt(job, { status: "queued", workerId: updated.workerId });
    return updated;
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  private async recordAttempt(
    job: JobRecord,
    write: DeliveryAttemptWrite,
  ): Promise<DeliveryAttempt | null> {
    if (!this.flags.isSplitEnabled(job.accountId)) {
      return null;
    }

    const deliveryJob = await this.attempts.ensureDeliveryJob({
      accountId: job.accountId,
      briefId: job.briefId,
      taskId: job.taskId,
      type: job.type,
      metadata: job.metadata,
    });

    // attempt_number is computed here, serialized per delivery job, so racing
    // callers receive strictly increasing numbers instead of colliding.
    return this.serializePerDeliveryJob(deliveryJob.id, async () => {
      const latest = await this.attempts.latestAttemptNumber(deliveryJob.id);
      return this.attempts.insertAttempt({
        ...write,
        deliveryJobId: deliveryJob.id,
        attemptNumber: latest + 1,
        startedAt: new Date(),
      });
    });
  }

  private serializePerDeliveryJob<T>(deliveryJobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.appendQueues.get(deliveryJobId) ?? Promise.resolve();
    const result = previous.then(work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );

    this.appendQueues.set(deliveryJobId, settled);
    void settled.then(() => {
      if (this.appendQueues.get(deliveryJobId) === settled) {
        this.appendQueues.delete(deliveryJobId);
      }
    });
    return result;
  }
}
