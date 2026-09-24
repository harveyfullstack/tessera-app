import type { DeliveryJobRepository, JobRepository } from "../domain/job-repository";
import type { DeliveryAttemptRecord, JobRecord } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export interface DlqEndpointSummary {
  pastBudgetCount: number;
  lastThreeAttemptBodies: (string | undefined)[];
}

export interface DlqSummary {
  pastBudgetCount: number;
  endpoints: Record<string, DlqEndpointSummary>;
  [key: string]: unknown;
}

export class DlqProcessor {
  public static readonly DEFAULT_RETRY_BUDGET = 8;
  private readonly accountBudgets = new Map<string, number>();

  constructor(
    private readonly jobs: JobRepository & Partial<DeliveryJobRepository>,
    private readonly jobRecords?: JobRecordService,
  ) {}

  getRetryBudget(accountId: string): number {
    return this.accountBudgets.get(accountId) ?? DlqProcessor.DEFAULT_RETRY_BUDGET;
  }

  setRetryBudget(accountId: string, budget: number): void {
    this.accountBudgets.set(accountId, budget);
  }

  resetRetryBudget(accountId: string): void {
    this.accountBudgets.delete(accountId);
  }

  async getAttemptCountForJob(job: JobRecord): Promise<number> {
    if (typeof (this.jobs as DeliveryJobRepository).listDeliveryAttempts === "function") {
      const attempts = await (this.jobs as DeliveryJobRepository).listDeliveryAttempts(job.id);
      if (attempts.length > 0) {
        return attempts.length;
      }
    }
    return job.retryCount + (job.status === "failed" || job.status === "completed" ? 1 : 0);
  }

  async isJobPastBudget(job: JobRecord): Promise<boolean> {
    const budget = this.getRetryBudget(job.accountId);
    const attempts = await this.getAttemptCountForJob(job);
    return attempts >= budget;
  }

  async filterDlqJobs(jobs: JobRecord[]): Promise<JobRecord[]> {
    const results: JobRecord[] = [];
    for (const job of jobs) {
      if (await this.isJobPastBudget(job)) {
        results.push(job);
      }
    }
    return results;
  }

  async processDrainDlq(briefId: string, accountId?: string): Promise<JobRecord[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    const movedToDlq: JobRecord[] = [];

    for (const job of jobs) {
      if (accountId && job.accountId !== accountId) {
        continue;
      }
      if (await this.isJobPastBudget(job)) {
        const updated = await this.jobs.updateExecution(job.id, {
          status: "failed",
          errorMessage: `Moved to Dead Letter Queue: exceeded retry budget of ${this.getRetryBudget(
            job.accountId,
          )} attempts`,
        });
        movedToDlq.push(updated);
      }
    }

    return movedToDlq;
  }

  async getDlqSummary(briefId: string): Promise<DlqSummary> {
    const allJobs = await this.jobs.listByBrief(briefId);
    const endpointJobs = new Map<string, JobRecord[]>();

    for (const job of allJobs) {
      const url = job.metadata?.endpointUrl ?? "unknown";
      const list = endpointJobs.get(url) ?? [];
      list.push(job);
      endpointJobs.set(url, list);
    }

    const endpoints: Record<string, DlqEndpointSummary> = {};
    let totalPastBudgetCount = 0;

    for (const [url, jobs] of endpointJobs.entries()) {
      let pastBudgetCountForEndpoint = 0;
      const allAttemptBodies: (string | undefined)[] = [];

      for (const job of jobs) {
        const count = await this.getAttemptCountForJob(job);
        const budget = this.getRetryBudget(job.accountId);
        if (count >= budget) {
          pastBudgetCountForEndpoint++;
          totalPastBudgetCount++;
        }

        // Collect attempt bodies from delivery_attempts or job error message
        if (typeof (this.jobs as DeliveryJobRepository).listDeliveryAttempts === "function") {
          const attempts = await (this.jobs as DeliveryJobRepository).listDeliveryAttempts(job.id);
          for (const attempt of attempts) {
            allAttemptBodies.push(attempt.errorBody ?? (attempt.status === "failed" ? "failure" : undefined));
          }
        }
        if (allAttemptBodies.length === 0 && job.errorMessage) {
          allAttemptBodies.push(job.errorMessage);
        }
      }

      const lastThreeAttemptBodies = allAttemptBodies.slice(-3);

      endpoints[url] = {
        pastBudgetCount: pastBudgetCountForEndpoint,
        lastThreeAttemptBodies,
      };
    }

    const summary: DlqSummary = {
      pastBudgetCount: totalPastBudgetCount,
      endpoints,
    };

    // Populate direct URL access on summary for flexible consumption
    for (const [url, endpointData] of Object.entries(endpoints)) {
      summary[url] = endpointData;
    }

    return summary;
  }
}
