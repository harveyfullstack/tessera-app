import type { AccountRetryBudget } from "../domain/account-retry-budget";
import type { DeliveryJobRepository } from "../domain/delivery-job-repository";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";
import type { RollbackFeatureFlag } from "../domain/rollback-feature-flag";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

const STUCK_AFTER_MS = 5 * 60 * 1000;

const DRAIN_DLQ_METADATA: JobMetadata = {
  customerId: "system",
  subscriptionId: "dlq-drain",
  endpointUrl: "internal://dlq-drain",
  eventType: "dlq.drain",
  payloadHash: "sha256:dlq",
};

export type DisplayStatus = JobStatus | "stuck" | "dlq";

export interface DlqAttemptBody {
  attemptNumber: number;
  status: JobStatus;
  errorBody?: string | undefined;
  responseStatus?: number | undefined;
}

export interface DlqEndpointSummary {
  endpointUrl: string;
  pastBudgetCount: number;
  lastAttempts: DlqAttemptBody[];
}

export interface BriefJobsResponse {
  jobs: Array<JobRecord & { displayStatus: DisplayStatus }>;
  dlq: DlqEndpointSummary[];
}

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc,
    private readonly deliveryJobs: DeliveryJobRepository,
    private readonly rollbackFlag: RollbackFeatureFlag,
    private readonly retryBudgets: AccountRetryBudget,
    private readonly now: () => Date = () => new Date(),
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
    return this.attempts.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    const job = await this.attempts.markFailed(jobId, errorMessage, details);
    if (await this.isInDlq(job)) {
      await this.ensureDrainDlqJob(job.accountId, job.briefId);
    }
    return job;
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attempts.retry(jobId);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
  }

  async listBriefJobs(briefId: string, status?: string): Promise<BriefJobsResponse> {
    const rows = await this.jobs.listByBrief(briefId);
    const jobs: BriefJobsResponse["jobs"] = [];

    for (const job of rows) {
      const displayStatus = await this.displayStatus(job);
      if (status && displayStatus !== status) {
        continue;
      }
      jobs.push({ ...job, displayStatus });
    }

    return {
      jobs,
      dlq: await this.buildDlqSummaries(rows),
    };
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

  async ensureDrainDlqJob(accountId: string, briefId: string): Promise<JobRecord> {
    return this.ensureJobRecord({
      accountId,
      briefId,
      type: "drain_dlq",
      metadata: DRAIN_DLQ_METADATA,
    });
  }

  async isInDlq(job: JobRecord): Promise<boolean> {
    const current = (await this.jobs.findById(job.id)) ?? job;
    if (current.type !== "dispatch_webhook") {
      return false;
    }

    const budget = this.retryBudgets.getRetryBudget(current.accountId);

    if (this.rollbackFlag.isEnabled(current.accountId)) {
      return current.status !== "completed" && current.retryCount >= budget;
    }

    const history = await this.attemptsFor(current);
    if (history[0]?.status === "completed") {
      return false;
    }

    return this.failedExecutionCount(history) >= budget;
  }

  async displayStatus(job: JobRecord): Promise<DisplayStatus> {
    const current = (await this.jobs.findById(job.id)) ?? job;

    if (this.rollbackFlag.isEnabled(current.accountId)) {
      if (await this.isInDlq(current)) {
        return "dlq";
      }
      return current.status;
    }

    const latest = await this.latestAttempt(current);
    if (!latest) {
      return "queued";
    }

    if (latest.status === "completed") {
      return "completed";
    }

    if (await this.isInDlq(current)) {
      return "dlq";
    }

    if (latest.status === "running") {
      const startedAt = latest.startedAt ?? latest.createdAt;
      if (this.now().getTime() - startedAt.getTime() > STUCK_AFTER_MS) {
        return "stuck";
      }
    }

    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }

  private async buildDlqSummaries(jobs: JobRecord[]): Promise<DlqEndpointSummary[]> {
    const byEndpoint = new Map<string, DlqEndpointSummary>();

    for (const job of jobs) {
      if (!(await this.isInDlq(job))) {
        continue;
      }

      const endpointUrl = job.metadata.endpointUrl;
      const existing = byEndpoint.get(endpointUrl) ?? {
        endpointUrl,
        pastBudgetCount: 0,
        lastAttempts: [],
      };

      existing.pastBudgetCount += 1;
      existing.lastAttempts = this.mergeLatestAttempts(
        existing.lastAttempts,
        this.lastAttemptBodies(await this.attemptsFor(job)),
      );
      byEndpoint.set(endpointUrl, existing);
    }

    return [...byEndpoint.values()];
  }

  private lastAttemptBodies(history: DeliveryAttempt[]): DlqAttemptBody[] {
    return history
      .filter((attempt) => attempt.status === "failed" || attempt.status === "completed")
      .slice(0, 3)
      .map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        errorBody: attempt.errorBody,
        responseStatus: attempt.responseStatus,
      }));
  }

  private mergeLatestAttempts(
    current: DlqAttemptBody[],
    incoming: DlqAttemptBody[],
  ): DlqAttemptBody[] {
    return [...current, ...incoming]
      .sort((a, b) => b.attemptNumber - a.attemptNumber)
      .slice(0, 3);
  }

  private failedExecutionCount(history: DeliveryAttempt[]): number {
    return history.filter((attempt) => attempt.status === "failed").length;
  }

  private async latestAttempt(job: JobRecord): Promise<DeliveryAttempt | undefined> {
    return (await this.attemptsFor(job))[0];
  }

  private async attemptsFor(job: JobRecord): Promise<DeliveryAttempt[]> {
    const deliveryJob = await this.deliveryJobs.findByAccountBriefAndType(
      job.accountId,
      job.briefId,
      job.type,
    );
    if (!deliveryJob) {
      return [];
    }

    return this.deliveryJobs.listAttempts(deliveryJob.id);
  }
}
