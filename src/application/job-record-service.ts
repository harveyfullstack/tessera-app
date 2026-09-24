import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type { DeliveryJobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobType,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository & Partial<DeliveryJobRepository>,
    rpc?: DeliveryAttemptRpc,
  ) {
    this.rpc = rpc ?? new DeliveryAttemptRpc(jobs);
  }

  getRpc(): DeliveryAttemptRpc {
    return this.rpc;
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Pre-migration behavior. If two callers race, duplicate intent rows are possible.
    return this.jobs.create(input);
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

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
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
    // Fall back to jobs.status when the rollback feature flag is on
    if (this.rpc.isRollbackActive(job.accountId)) {
      return job.status ?? "queued";
    }

    let latestAttempt: DeliveryAttemptRecord | null = null;
    if (typeof (this.jobs as DeliveryJobRepository).getLatestDeliveryAttempt === "function") {
      latestAttempt = await (this.jobs as DeliveryJobRepository).getLatestDeliveryAttempt(job.id);
    }

    if (!latestAttempt) {
      return "queued";
    }

    if (latestAttempt.status === "running" && latestAttempt.startedAt) {
      const fiveMinutesMs = 5 * 60 * 1000;
      if (now.getTime() - latestAttempt.startedAt.getTime() > fiveMinutesMs) {
        return "stuck";
      }
    }

    return latestAttempt.status;
  }

  static async displayStatus(
    job: JobRecord,
    options?: {
      rpc?: DeliveryAttemptRpc;
      repository?: JobRepository & Partial<DeliveryJobRepository>;
      latestAttempt?: DeliveryAttemptRecord | null;
      now?: Date;
    },
  ): Promise<string> {
    const now = options?.now ?? new Date();
    if (options?.rpc && options.rpc.isRollbackActive(job.accountId)) {
      return job.status ?? "queued";
    }

    let latestAttempt = options?.latestAttempt;
    if (latestAttempt === undefined && options?.repository) {
      if (typeof (options.repository as DeliveryJobRepository).getLatestDeliveryAttempt === "function") {
        latestAttempt = await (options.repository as DeliveryJobRepository).getLatestDeliveryAttempt(
          job.id,
        );
      }
    }

    if (!latestAttempt) {
      if (options?.latestAttempt === null || options?.repository) {
        return "queued";
      }
      return job.status ?? "queued";
    }

    if (latestAttempt.status === "running" && latestAttempt.startedAt) {
      const fiveMinutesMs = 5 * 60 * 1000;
      if (now.getTime() - latestAttempt.startedAt.getTime() > fiveMinutesMs) {
        return "stuck";
      }
    }

    return latestAttempt.status;
  }

  async canStartNewDelivery(job: JobRecord, now?: Date): Promise<boolean> {
    const status = await this.displayStatus(job, now);
    return status !== "running" && status !== "stuck";
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    return job.status !== "running";
  }
}
