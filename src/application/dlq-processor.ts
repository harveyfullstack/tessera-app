import type { JobRecord } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export const DEFAULT_RETRY_BUDGET = 8;

export class RetryBudgetPolicy {
  private readonly budgets = new Map<string, number>();

  constructor(defaultBudget = DEFAULT_RETRY_BUDGET) {
    if (!Number.isInteger(defaultBudget) || defaultBudget < 1) {
      throw new Error("Retry budget must be a positive integer");
    }
    this.defaultBudget = defaultBudget;
  }

  private readonly defaultBudget: number;

  set(accountId: string, budget: number): void {
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error("Retry budget must be a positive integer");
    }
    this.budgets.set(accountId, budget);
  }

  get(accountId: string): number {
    return this.budgets.get(accountId) ?? this.defaultBudget;
  }
}

export interface DlqSummary {
  pastBudgetCount: number;
  lastThreeAttemptBodies: string[];
}

export class DlqProcessor {
  constructor(
    private readonly jobs: JobRecordService,
    private readonly retryBudgets = new RetryBudgetPolicy(),
  ) {}

  setRetryBudget(accountId: string, budget: number): void {
    this.retryBudgets.set(accountId, budget);
  }

  retryBudget(accountId: string): number {
    return this.retryBudgets.get(accountId);
  }

  async drain(briefId: string, accountId?: string): Promise<JobRecord[]> {
    const rows = await this.jobs.listByBrief(briefId);
    const eligible = rows.filter((job) => {
      const budget = this.retryBudgets.get(accountId ?? job.accountId);
      return (
        job.type === "dispatch_webhook" &&
        job.status === "failed" &&
        job.retryCount >= budget
      );
    });

    return Promise.all(eligible.map((job) => this.jobs.markDeadLettered(job.id)));
  }

  async summary(job: JobRecord): Promise<DlqSummary> {
    const budget = this.retryBudgets.get(job.accountId);
    const attempts = await this.jobs.listAttempts(job.id);
    return {
      pastBudgetCount:
        job.status === "dlq" ? Math.max(1, job.retryCount - budget + 1) : 0,
      lastThreeAttemptBodies: attempts
        .map((attempt) => attempt.details?.errorBody ?? attempt.errorMessage)
        .filter((body): body is string => Boolean(body))
        .slice(-3),
    };
  }
}
