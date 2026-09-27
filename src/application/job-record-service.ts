import { JobNotFoundError } from "../domain/errors";
import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  private readonly deliveryAttempts: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    deliveryAttempts?: DeliveryAttemptRpc,
  ) {
    this.deliveryAttempts = deliveryAttempts ?? new DeliveryAttemptRpc(jobs);
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
    return this.deliveryAttempts.record(jobId, {
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
    return this.deliveryAttempts.record(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.deliveryAttempts.record(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.deliveryAttempts.retry(jobId);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    return Promise.all(
      jobs.map(async (job) => ({
        ...job,
        status: job.status === "dlq"
          ? "dlq"
          : (await this.displayStatus(job)) as JobRecord["status"],
      })),
    );
  }

  async listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]> {
    return this.deliveryAttempts.listAttempts(jobId);
  }

  async markDeadLettered(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }

    return this.jobs.updateExecution(jobId, { status: "dlq" });
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

  async displayStatus(job: JobRecord): Promise<string> {
    if (this.deliveryAttempts.isRollbackEnabledForAccount(job.accountId)) {
      const current = await this.jobs.findById(job.id);
      return current?.status ?? job.status ?? "queued";
    }

    const attempts = await this.deliveryAttempts.listAttempts(job.id);
    return JobRecordService.displayStatusFromAttempts(attempts);
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running" && status !== "stuck";
  }

  static displayStatus(job: JobRecord, attempts?: DeliveryAttemptRecord[]): string {
    return attempts === undefined
      ? job.status
      : JobRecordService.displayStatusFromAttempts(attempts);
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job);
    return status !== "running" && status !== "stuck";
  }

  private static displayStatusFromAttempts(
    attempts: DeliveryAttemptRecord[],
  ): string {
    if (attempts.length === 0) {
      return "queued";
    }

    const latest = attempts.reduce((current, candidate) =>
      candidate.attemptNumber > current.attemptNumber ? candidate : current,
    );

    if (latest.status === "running" && Date.now() - latest.startedAt.getTime() > 5 * 60 * 1000) {
      return "stuck";
    }

    return latest.status;
  }
}
