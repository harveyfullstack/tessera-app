import { jobRecordFromDelivery } from "../domain/delivery";
import type { DeliveryJob } from "../domain/delivery";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
} from "../domain/delivery-repository";
import type {
  DeliveryAttemptRepository,
  DeliveryJobRepository,
} from "../domain/delivery-repository";
import { JobNotFoundError } from "../domain/errors";
import type {
  JobExecutionDetails,
  JobRecord,
  JobStatus,
  UpdateJobExecutionInput,
} from "../domain/job";
import type { JobRepository } from "../domain/job-repository";
import type { DeliverySplitFlags } from "./delivery-split-flags";

export interface DeliveryAttemptWrite {
  status: JobStatus;
  workerId?: string | undefined;
  errorMessage?: string | undefined;
  details?: JobExecutionDetails | undefined;
}

export class DeliveryAttemptRpc {
  constructor(
    private readonly flags: DeliverySplitFlags,
    private readonly jobs: JobRepository,
    private readonly deliveryJobs: DeliveryJobRepository,
    private readonly deliveryAttempts: DeliveryAttemptRepository,
  ) {}

  async markRunning(job: JobRecord, workerId: string): Promise<JobRecord> {
    return this.write(job, {
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
    return this.write(job, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(job: JobRecord, details: JobExecutionDetails): Promise<JobRecord> {
    return this.write(job, {
      status: "completed",
      details,
    });
  }

  async retry(job: JobRecord): Promise<JobRecord> {
    return this.write(job, { status: "queued" });
  }

  private async write(job: JobRecord, input: DeliveryAttemptWrite): Promise<JobRecord> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return this.writeLegacy(job.id, input);
    }

    const deliveryJob = await this.ensureDeliveryJob(job);
    const now = new Date();
    const attempt = await this.insertMonotonic({
      deliveryJobId: deliveryJob.id,
      workerId: input.workerId ?? input.details?.workerId,
      status: input.status,
      responseStatus: input.details?.responseStatus,
      responseLatencyMs: input.details?.responseLatencyMs,
      errorBody: input.errorMessage ?? input.details?.errorBody,
      startedAt: input.status === "running" ? now : undefined,
      createdAt: now,
    });

    const attempts = await this.deliveryAttempts.listByDeliveryJobId(deliveryJob.id);
    if (!attempts.some((row) => row.id === attempt.id)) {
      attempts.push(attempt);
    }
    return jobRecordFromDelivery(deliveryJob, attempts);
  }

  private async writeLegacy(jobId: string, input: DeliveryAttemptWrite): Promise<JobRecord> {
    if (input.status === "queued") {
      return this.jobs.incrementRetry(jobId);
    }

    const update: UpdateJobExecutionInput = {
      status: input.status,
      workerId: input.workerId,
      errorMessage: input.errorMessage,
      details: input.details,
    };
    return this.jobs.updateExecution(jobId, update);
  }

  private async ensureDeliveryJob(job: JobRecord): Promise<DeliveryJob> {
    const byId = await this.deliveryJobs.findById(job.id);
    if (byId) {
      return byId;
    }

    const byKey = await this.deliveryJobs.findByIntentKey({
      accountId: job.accountId,
      briefId: job.briefId,
      type: job.type,
    });
    if (byKey) {
      return byKey;
    }

    try {
      return await this.deliveryJobs.create({
        id: job.id,
        accountId: job.accountId,
        briefId: job.briefId,
        taskId: job.taskId,
        parentJobId: job.parentJobId,
        type: job.type,
        metadata: job.metadata,
        createdAt: job.createdAt,
      });
    } catch (error) {
      if (!(error instanceof DuplicateDeliveryJobError)) {
        throw error;
      }

      const existing = await this.deliveryJobs.findByIntentKey({
        accountId: job.accountId,
        briefId: job.briefId,
        type: job.type,
      });
      if (!existing) {
        throw new JobNotFoundError(job.id);
      }
      return existing;
    }
  }

  private async insertMonotonic(
    input: Parameters<DeliveryAttemptRepository["insert"]>[0],
  ): Promise<Awaited<ReturnType<DeliveryAttemptRepository["insert"]>>> {
    for (;;) {
      const attemptNumber = await this.deliveryAttempts.nextAttemptNumber(input.deliveryJobId);
      try {
        return await this.deliveryAttempts.insert({ ...input, attemptNumber });
      } catch (error) {
        if (!(error instanceof DuplicateDeliveryAttemptError)) {
          throw error;
        }
      }
    }
  }
}
