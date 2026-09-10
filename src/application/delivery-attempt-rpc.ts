import type { DeliveryJobRepository } from "../domain/delivery-job-repository";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
  JobNotFoundError,
} from "../domain/errors";
import type {
  CreateDeliveryAttemptInput,
  DeliveryAttempt,
  DeliveryJob,
  JobExecutionDetails,
  JobRecord,
} from "../domain/job";
import type { JobRepository } from "../domain/job-repository";
import type { RollbackFeatureFlag } from "../domain/rollback-feature-flag";

type AttemptWrite = Omit<CreateDeliveryAttemptInput, "deliveryJobId" | "attemptNumber">;

export class DeliveryAttemptRpc {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly jobs: JobRepository,
    private readonly deliveryJobs: DeliveryJobRepository,
    private readonly rollbackFlag: RollbackFeatureFlag,
  ) {}

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.execute(
      jobId,
      (job) =>
        this.jobs.updateExecution(job.id, {
          status: "running",
          workerId,
          details: { workerId },
        }),
      { status: "running", workerId },
    );
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.execute(
      jobId,
      (job) =>
        this.jobs.updateExecution(job.id, {
          status: "failed",
          errorMessage,
          details,
        }),
      {
        status: "failed",
        workerId: details?.workerId,
        responseStatus: details?.responseStatus,
        responseLatencyMs: details?.responseLatencyMs,
        errorBody: errorMessage,
      },
    );
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.execute(
      jobId,
      (job) =>
        this.jobs.updateExecution(job.id, {
          status: "completed",
          details,
        }),
      {
        status: "completed",
        workerId: details.workerId,
        responseStatus: details.responseStatus,
        responseLatencyMs: details.responseLatencyMs,
        errorBody: details.errorBody,
      },
    );
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.execute(jobId, (job) => this.jobs.incrementRetry(job.id), {
      status: "queued",
    });
  }

  private async execute(
    jobId: string,
    rollback: (job: JobRecord) => Promise<JobRecord>,
    attempt: AttemptWrite,
  ): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (this.rollbackFlag.isEnabled(job.accountId)) {
      return rollback(job);
    }

    return this.serializeWrite(() => this.writeAttempt(job, attempt));
  }

  private serializeWrite<T>(write: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(write, write);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeAttempt(job: JobRecord, fields: AttemptWrite): Promise<JobRecord> {
    const deliveryJob = await this.resolveDeliveryJob(job);
    const written = await this.insertAttempt(deliveryJob.id, fields);
    const history = await this.deliveryJobs.listAttempts(deliveryJob.id);
    return this.project(job, written, history);
  }

  private async resolveDeliveryJob(job: JobRecord): Promise<DeliveryJob> {
    const existing = await this.deliveryJobs.findByAccountBriefAndType(
      job.accountId,
      job.briefId,
      job.type,
    );
    if (existing) {
      return existing;
    }

    try {
      return await this.deliveryJobs.create({
        accountId: job.accountId,
        briefId: job.briefId,
        taskId: job.taskId,
        parentJobId: job.parentJobId,
        type: job.type,
        metadata: job.metadata,
      });
    } catch (error) {
      if (error instanceof DuplicateDeliveryJobError) {
        const raced = await this.deliveryJobs.findByAccountBriefAndType(
          job.accountId,
          job.briefId,
          job.type,
        );
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  private async insertAttempt(
    deliveryJobId: string,
    fields: AttemptWrite,
  ): Promise<DeliveryAttempt> {
    for (;;) {
      const history = await this.deliveryJobs.listAttempts(deliveryJobId);
      const attemptNumber = (history[0]?.attemptNumber ?? 0) + 1;
      try {
        return await this.deliveryJobs.appendAttempt({
          deliveryJobId,
          attemptNumber,
          ...fields,
        });
      } catch (error) {
        if (error instanceof DuplicateDeliveryAttemptError) {
          continue;
        }
        throw error;
      }
    }
  }

  private project(
    job: JobRecord,
    attempt: DeliveryAttempt,
    history: DeliveryAttempt[],
  ): JobRecord {
    const terminal =
      attempt.status === "completed" ||
      attempt.status === "failed" ||
      attempt.status === "cancelled";

    return {
      ...job,
      status: attempt.status,
      workerId: attempt.workerId ?? job.workerId,
      errorMessage: attempt.errorBody,
      retryCount: history.filter((row) => row.status === "queued").length,
      updatedAt: attempt.createdAt,
      startedAt: attempt.status === "running" ? attempt.createdAt : job.startedAt,
      completedAt: terminal ? attempt.createdAt : job.completedAt,
    };
  }
}
