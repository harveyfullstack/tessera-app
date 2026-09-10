import { DuplicateIntentError, JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import { AccountRetryBudgetRegistry } from "./account-retry-budget";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export const STUCK_ATTEMPT_AFTER_MS = 5 * 60 * 1000;

export type JobRecordView = JobRecord & { displayStatus: string };

export interface DlqEndpointSummary {
  endpointUrl: string;
  lastThreeAttemptBodies: string[];
}

export interface DlqSummary {
  pastBudgetCount: number;
  endpoints: DlqEndpointSummary[];
}

export interface JobsListResponse {
  jobs: JobRecordView[];
  dlq: DlqSummary;
}

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;
  private readonly budgets: AccountRetryBudgetRegistry;

  constructor(
    private readonly jobs: JobRepository,
    rpc?: DeliveryAttemptRpc,
    budgets?: AccountRetryBudgetRegistry,
  ) {
    this.rpc = rpc ?? new DeliveryAttemptRpc(jobs);
    this.budgets = budgets ?? new AccountRetryBudgetRegistry();
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return this.jobs.findById(jobId);
  }

  async listIntentByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
  }

  async markDeadLettered(jobId: string): Promise<JobRecord> {
    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw new JobNotFoundError(jobId);
    }
    return this.jobs.markDeadLettered(jobId);
  }

  retryBudgetFor(accountId: string): number {
    return this.budgets.get(accountId);
  }

  async isPastRetryBudget(job: JobRecord): Promise<boolean> {
    if (job.type !== "dispatch_webhook") {
      return false;
    }
    const attempts = await this.jobs.listAttempts(job.id);
    return attempts.length >= this.budgets.get(job.accountId);
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

  async listByBrief(briefId: string, status?: string): Promise<JobRecordView[]> {
    const rows = await this.jobs.listByBrief(briefId);
    const views = await Promise.all(
      rows.map(async (job) => ({
        ...job,
        displayStatus: await this.displayStatus(job),
      })),
    );

    if (!status) {
      return views;
    }

    if (status === "dlq") {
      const matches = await Promise.all(
        views.map(async (job) => ({
          job,
          include: job.displayStatus === "dlq" || (await this.isPastRetryBudget(job)),
        })),
      );
      return matches.filter((row) => row.include).map((row) => row.job);
    }

    return views.filter((job) => job.displayStatus === status);
  }

  async dlqSummary(briefId: string): Promise<DlqSummary> {
    const rows = (await this.jobs.listByBrief(briefId)).filter((job) => job.type === "dispatch_webhook");
    const endpoints: DlqEndpointSummary[] = [];
    let pastBudgetCount = 0;

    for (const job of rows) {
      if (!(await this.isPastRetryBudget(job))) {
        continue;
      }
      pastBudgetCount += 1;
      const attempts = await this.jobs.listAttempts(job.id);
      endpoints.push({
        endpointUrl: job.metadata.endpointUrl,
        lastThreeAttemptBodies: attempts.slice(0, 3).map((attempt) => attempt.errorBody ?? ""),
      });
    }

    return { pastBudgetCount, endpoints };
  }

  async listJobsResponse(briefId: string, status?: string): Promise<JobsListResponse> {
    const [jobs, dlq] = await Promise.all([this.listByBrief(briefId, status), this.dlqSummary(briefId)]);
    return { jobs, dlq };
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

    if (job.deadLetteredAt) {
      return "dlq";
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
