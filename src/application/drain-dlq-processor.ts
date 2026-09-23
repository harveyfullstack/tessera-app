import type { JobRecord } from "../domain/job";
import type { DeliveryAttempt } from "../domain/delivery-attempt";
import { JobRecordService } from "./job-record-service";

export const DEFAULT_RETRY_BUDGET = 8;

export class AccountRetryBudgets {
  private readonly budgets: ReadonlyMap<string, number>;

  constructor(budgets: ReadonlyMap<string, number> = new Map()) {
    for (const budget of budgets.values()) {
      if (!Number.isSafeInteger(budget) || budget < 1) {
        throw new Error("Retry budgets must be positive safe integers");
      }
    }
    this.budgets = new Map(budgets);
  }

  forAccount(accountId: string): number {
    return this.budgets.get(accountId) ?? DEFAULT_RETRY_BUDGET;
  }
}

export interface DlqEndpointSummary {
  endpointUrl: string;
  pastBudgetCount: number;
  lastAttempts: DeliveryAttempt[];
}

export interface DlqSummary {
  // Counts exhausted delivery intents, not lifecycle events or excess retries.
  pastBudgetCount: number;
  endpoints: DlqEndpointSummary[];
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobs: JobRecordService,
    private readonly budgets = new AccountRetryBudgets(),
  ) {}

  async process(accountId: string, briefId: string, workerId: string): Promise<JobRecord | null> {
    const jobs = await this.jobs.listByBrief(briefId, accountId);
    const dispatch = jobs.find((job) => job.type === "dispatch_webhook");
    if (!dispatch) return null;
    const drain = await this.jobs.ensureJobRecord({
      accountId, briefId, type: "drain_dlq", metadata: dispatch.metadata,
    });
    await this.jobs.markRunning(drain.id, workerId);
    try {
      for (const job of jobs) {
        if (job.type !== "dispatch_webhook" || job.status !== "failed") continue;
        const attempts = await this.jobs.listAttempts(job.id);
        const latest = attempts.at(-1);
        if (latest && this.isExhausted(job, attempts)) {
          await this.jobs.markDeadLettered(job.id, latest.attemptNumber);
        }
      }
      return await this.jobs.markCompleted(drain.id, { workerId });
    } catch (error) {
      await this.jobs.markFailed(drain.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async summarize(jobs: JobRecord[]): Promise<DlqSummary> {
    const endpoints = new Map<string, DlqEndpointSummary>();
    for (const job of jobs) {
      if (job.type !== "dispatch_webhook") continue;
      const attempts = await this.jobs.listAttempts(job.id);
      if (!this.isExhausted(job, attempts)) continue;
      const endpoint = endpoints.get(job.metadata.endpointUrl) ?? {
        endpointUrl: job.metadata.endpointUrl, pastBudgetCount: 0, lastAttempts: [],
      };
      endpoint.pastBudgetCount += 1;
      endpoint.lastAttempts = [...endpoint.lastAttempts, ...attempts.filter(isExecutionResult)]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.attemptNumber - a.attemptNumber)
        .slice(0, 3);
      endpoints.set(endpoint.endpointUrl, endpoint);
    }
    return {
      pastBudgetCount: [...endpoints.values()].reduce((count, endpoint) => count + endpoint.pastBudgetCount, 0),
      endpoints: [...endpoints.values()],
    };
  }

  private isExhausted(job: JobRecord, attempts: DeliveryAttempt[]): boolean {
    return job.status === "dlq" || (job.status === "failed" &&
      attempts.filter((attempt) => attempt.operation === "execution" && attempt.status === "failed").length >= this.budgets.forAccount(job.accountId));
  }
}

function isExecutionResult(attempt: DeliveryAttempt): boolean {
  return attempt.operation === "execution" && (attempt.status === "failed" || attempt.status === "completed");
}
