import { DuplicateIntentError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export const STUCK_ATTEMPT_AFTER_MS = 5 * 60 * 1000;

export type JobRecordView = JobRecord & { displayStatus: string };

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    rpc?: DeliveryAttemptRpc,
  ) {
    this.rpc = rpc ?? new DeliveryAttemptRpc(jobs);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    try {
      return await this.jobs.create(input);
    } catch (error) {
      if (error instanceof DuplicateIntentError) {
        const raced = await this.jobs.findByBriefAndType(input.briefId, input.type);
        const winner = raced[0];
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.rpc.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.rpc.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.rpc.retry(jobId);
  }

  async listByBrief(briefId: string): Promise<JobRecordView[]> {
    const rows = await this.jobs.listByBrief(briefId);
    return Promise.all(
      rows.map(async (job) => ({
        ...job,
        displayStatus: await this.displayStatus(job),
      })),
    );
  }

  async ensureWebhookDispatchJob(
    accountId: string,
    briefId: string,
    metadata: JobMetadata,
  ): Promise<JobRecord> {
    return this.ensureJobRecord({
      accountId,
      briefId,
      type: "dispatch_webhook",
      metadata,
    });
  }

  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<string> {
    if (this.rpc.isRollbackEnabled()) {
      return job.status ?? "queued";
    }

    const attempts = await this.jobs.listAttempts(job.id);
    const latest = attempts.reduce<DeliveryAttempt | undefined>((current, attempt) => {
      if (!current || attempt.attemptNumber > current.attemptNumber) {
        return attempt;
      }
      return current;
    }, undefined);

    if (!latest) {
      return "queued";
    }

    if (
      latest.status === "running" &&
      latest.startedAt !== undefined &&
      now.getTime() - latest.startedAt.getTime() > STUCK_ATTEMPT_AFTER_MS
    ) {
      return "stuck";
    }

    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord, now: Date = new Date()): Promise<boolean> {
    const status = await this.displayStatus(job, now);
    return status !== "running";
  }
}
