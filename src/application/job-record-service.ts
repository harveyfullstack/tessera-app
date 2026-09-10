import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { DeliverySplitFlags } from "./delivery-split-flags";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

export const STUCK_ATTEMPT_AFTER_MS = 5 * 60 * 1000;

export interface JobRecordView extends JobRecord {
  displayStatus: string;
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attemptRpc: DeliveryAttemptRpc,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly flags: DeliverySplitFlags,
  ) {}

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
    return this.attemptRpc.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attemptRpc.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attemptRpc.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attemptRpc.retry(jobId);
  }

  async listByBrief(briefId: string, now: Date = new Date()): Promise<JobRecordView[]> {
    const rows = await this.jobs.listByBrief(briefId);
    return Promise.all(rows.map((job) => this.toView(job, now)));
  }

  async toView(job: JobRecord, now: Date = new Date()): Promise<JobRecordView> {
    return {
      ...job,
      displayStatus: await this.displayStatus(job, now),
    };
  }

  async displayStatus(job: JobRecord, now: Date = new Date()): Promise<string> {
    if (this.flags.isRollbackEnabled(job.accountId)) {
      return job.status ?? "queued";
    }

    const latest = await this.attempts.latestByDeliveryJobId(job.id);
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

  async canStartNewDelivery(job: JobRecord, now: Date = new Date()): Promise<boolean> {
    const status = await this.displayStatus(job, now);
    return status !== "running";
  }
}
