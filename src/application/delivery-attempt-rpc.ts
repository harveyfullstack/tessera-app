import { JobNotFoundError } from "../domain/errors";
import type {
  CreateDeliveryAttemptInput,
  DeliveryAttempt,
} from "../domain/delivery-attempt";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import type {
  JobExecutionDetails,
  JobRecord,
  JobStatus,
  UpdateJobExecutionInput,
} from "../domain/job";

export type RollbackFeatureFlag = (accountId: string) => boolean;

const STUCK_AFTER_MS = 5 * 60 * 1000;

type DeliveryAttemptCommand =
  | { type: "execution"; input: UpdateJobExecutionInput }
  | { type: "retry" };

export class DeliveryAttemptRpc {
  private readonly jobLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly rollbackEnabled: RollbackFeatureFlag = () => false,
  ) {}

  markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.write(jobId, {
      type: "execution",
      input: { status: "running", workerId, details: { workerId } },
    });
  }

  markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.write(jobId, {
      type: "execution",
      input: { status: "failed", errorMessage, details },
    });
  }

  markCompleted(
    jobId: string,
    details: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.write(jobId, {
      type: "execution",
      input: { status: "completed", details },
    });
  }

  retry(jobId: string): Promise<JobRecord> {
    return this.write(jobId, { type: "retry" });
  }

  async getJobRecord(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (this.rollbackEnabled(job.accountId)) {
      return job;
    }

    return this.projectJob(job, await this.attempts.listByJobId(jobId));
  }

  async getDisplayStatus(jobId: string): Promise<JobStatus | "stuck"> {
    const job = await this.jobs.findById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (this.rollbackEnabled(job.accountId)) {
      return job.status;
    }

    const latest = (await this.attempts.listByJobId(jobId)).reduce<
      DeliveryAttempt | undefined
    >(
      (current, attempt) =>
        !current || attempt.attemptNumber > current.attemptNumber
          ? attempt
          : current,
      undefined,
    );

    if (!latest) {
      return "queued";
    }

    if (
      latest.status === "running" &&
      latest.startedAt &&
      Date.now() - latest.startedAt.getTime() > STUCK_AFTER_MS
    ) {
      return "stuck";
    }

    return latest.status;
  }

  private async write(
    jobId: string,
    command: DeliveryAttemptCommand,
  ): Promise<JobRecord> {
    return this.withJobLock(jobId, async () => {
      const job = await this.jobs.findById(jobId);
      if (!job) {
        throw new JobNotFoundError(jobId);
      }

      if (this.rollbackEnabled(job.accountId)) {
        return command.type === "retry"
          ? this.jobs.incrementRetry(jobId)
          : this.jobs.updateExecution(jobId, command.input);
      }

      const history = await this.attempts.listByJobId(jobId);
      const attempt = this.createAttempt(jobId, command, history);
      const inserted = await this.attempts.insert(attempt);
      return this.projectJob(job, [...history, inserted]);
    });
  }

  private createAttempt(
    jobId: string,
    command: DeliveryAttemptCommand,
    history: DeliveryAttempt[],
  ): CreateDeliveryAttemptInput {
    const input = command.type === "execution" ? command.input : undefined;
    const now = new Date();
    const status: JobStatus = input?.status ?? "queued";
    const previousWorkerId = [...history].reverse().find((item) => item.workerId)?.workerId;
    const previousStart = [...history]
      .reverse()
      .find((item) => item.status === "running")?.startedAt;

    return {
      deliveryJobId: jobId,
      attemptNumber:
        history.reduce(
          (maximum, attempt) => Math.max(maximum, attempt.attemptNumber),
          0,
        ) + 1,
      status,
      workerId: input?.workerId ?? (status === "queued" ? undefined : previousWorkerId),
      errorMessage: input?.errorMessage,
      responseStatus: input?.details?.responseStatus,
      responseLatencyMs: input?.details?.responseLatencyMs,
      errorBody:
        status === "failed"
          ? input?.details?.errorBody ?? input?.errorMessage
          : undefined,
      startedAt: status === "running" ? now : previousStart,
      completedAt:
        status === "completed" || status === "failed" ? now : undefined,
    };
  }

  private projectJob(job: JobRecord, history: DeliveryAttempt[]): JobRecord {
    const latest = history.at(-1);
    if (!latest) {
      return job;
    }

    const startedAt =
      latest.status === "running"
        ? latest.startedAt
        : [...history].reverse().find((attempt) => attempt.startedAt)?.startedAt;

    return {
      ...job,
      status: latest.status,
      workerId:
        latest.workerId ??
        [...history].reverse().find((attempt) => attempt.workerId)?.workerId,
      retryCount: history.filter((attempt) => attempt.status === "queued").length,
      errorMessage:
        latest.status === "failed"
          ? latest.errorMessage ?? latest.errorBody
          : undefined,
      startedAt,
      completedAt:
        latest.status === "completed" || latest.status === "failed"
          ? latest.completedAt
          : undefined,
      updatedAt: latest.createdAt,
    };
  }

  private async withJobLock<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.jobLocks.get(jobId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.jobLocks.set(jobId, lock);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.jobLocks.get(jobId) === lock) {
        this.jobLocks.delete(jobId);
      }
    }
  }
}
