import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { DeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";
import type { AccountRetryBudget } from "./account-retry-budget";

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export type DisplayStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stuck" | "dlq";

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

  async displayStatus(job: JobRecord): Promise<DisplayStatus> {
    if (this.rollbackFlags.isRollbackEnabled(job.accountId)) {
      return (job.status ?? "queued") as DisplayStatus;
    }

    const latest = await this.attemptRpc.getLatestAttempt(job.id);
    if (!latest) {
      return "queued";
    }

    const budget = this.retryBudgets.getRetryBudget(job.accountId);
    const attemptCount = await this.attemptRpc.countAttempts(job.id);
    const effectiveAttempts = Math.max(attemptCount, job.retryCount);
    if (effectiveAttempts >= budget) {
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
    return status !== "running";
  }
}
