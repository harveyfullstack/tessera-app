import { deliveryFailureCount } from "../domain/job";
import { JobNotFoundError } from "../domain/errors";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryDlqSummary,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc = new DeliveryAttemptRpc(jobs),
    private readonly now: () => number = Date.now,
    private readonly retryBudgets: ReadonlyMap<string, number> = new Map(),
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    return this.jobs.ensure(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "running", workerId, details: { workerId } },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "failed", errorMessage, details },
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "completed", details },
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, { kind: "retry" });
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

  async displayStatus(job: JobRecord): Promise<JobStatus | "stuck"> {
    if (!this.attempts.usesAttempts(job.accountId)) return job.status;
    const history = await this.jobs.listAttempts(job.deliveryJobId);
    const latest = history.reduce<(typeof history)[number] | undefined>(
      (current, attempt) => !current || attempt.attemptNumber > current.attemptNumber
        ? attempt : current,
      undefined,
    );
    if (!latest) return job.status;
    if (latest.status === "running" && this.now() - latest.startedAt.getTime() > STUCK_AFTER_MS) {
      return "stuck";
    }
    return latest.status;
  }

  async dlqSummary(job: JobRecord): Promise<DeliveryDlqSummary | null> {
    if (!this.attempts.usesAttempts(job.accountId) || job.type !== "dispatch_webhook") return null;
    const intent = await this.jobs.findDeliveryJob(job.deliveryJobId);
    if (!intent) throw new JobNotFoundError(job.deliveryJobId);
    const history = (await this.jobs.listAttempts(job.deliveryJobId))
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
    const retryBudget = this.retryBudgets.get(job.accountId) ?? 8;
    if (!Number.isSafeInteger(retryBudget) || retryBudget < 1) throw new Error("Invalid retry budget");
    // Lifecycle rows are not network attempts. Retain the surviving pre-cutover signal.
    const siblings = (await this.jobs.listByBrief(job.briefId))
      .filter((row) => row.deliveryJobId === job.deliveryJobId);
    const failureCount = deliveryFailureCount(history, siblings.map((row) => row.retryCount));
    return {
      deliveryJobId: intent.id, endpointUrl: intent.metadata.endpointUrl, retryBudget,
      failureCount, pastBudgetCount: Math.max(0, failureCount - retryBudget),
      attempts: history.filter((row) => row.errorBody !== undefined).slice(0, 3),
    };
  }

  async drainDlq(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    const summary = await this.dlqSummary(job);
    if (!summary) return job;
    return this.attempts.execute(job.id, { kind: "drain_dlq", retryBudget: summary.retryBudget });
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running" && (status !== "dlq" || !this.attempts.usesAttempts(job.accountId));
  }
}
