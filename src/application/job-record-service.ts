import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import type { AccountRetryBudget } from "./account-retry-budget";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { DeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export type DisplayStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stuck"
  | "dlq";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attemptRpc: DeliveryAttemptRpc,
    private readonly rollbackFlags: DeliveryAttemptRollbackFlags,
    private readonly retryBudgets: AccountRetryBudget,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

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

  private async currentJob(job: JobRecord): Promise<JobRecord> {
    const current = await this.jobs.findById(job.id);
    if (!current) {
      throw new JobNotFoundError(job.id);
    }
    return current;
  }

  async isInDlq(job: JobRecord): Promise<boolean> {
    const current = await this.currentJob(job);
    const budget = this.retryBudgets.getRetryBudget(current.accountId);

    if (this.rollbackFlags.isRollbackEnabled(current.accountId)) {
      return current.status !== "completed" && current.retryCount >= budget;
    }

    const latest = await this.attemptRpc.getLatestAttempt(current.id);
    if (latest?.status === "completed") {
      return false;
    }

    const failedCount = await this.attemptRpc.countFailedExecutions(current.id);
    return failedCount >= budget;
  }

  async displayStatus(job: JobRecord): Promise<DisplayStatus> {
    const current = await this.currentJob(job);

    if (this.rollbackFlags.isRollbackEnabled(current.accountId)) {
      if (await this.isInDlq(current)) {
        return "dlq";
      }
      return (current.status ?? "queued") as DisplayStatus;
    }

    const latest = await this.attemptRpc.getLatestAttempt(current.id);
    if (!latest) {
      return "queued";
    }

    if (latest.status === "completed") {
      return "completed";
    }

    if ((await this.isInDlq(current)) && latest.status === "failed") {
      return "dlq";
    }

    if (latest.status === "running") {
      const ageMs = Date.now() - latest.startedAt.getTime();
      if (ageMs > STUCK_THRESHOLD_MS) {
        return "stuck";
      }
    }

    return latest.status as DisplayStatus;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running" && status !== "stuck";
  }
}
