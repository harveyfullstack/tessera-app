import type { DeliveryAttemptReader, DeliveryAttemptSnapshot } from "../domain/delivery-attempt-reader";
import type { JobRecord } from "../domain/job";
import type { RetryBudgetPolicy } from "./retry-budget-policy";

export const DLQ_LAST_ATTEMPTS_SHOWN = 3;

export interface DlqBoundEndpoint {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  endpointUrl: string;
  attemptCount: number;
  retryBudget: number;
  // Newest first, at most DLQ_LAST_ATTEMPTS_SHOWN.
  lastAttempts: DeliveryAttemptSnapshot[];
}

export interface DlqSummary {
  count: number;
  endpoints: DlqBoundEndpoint[];
}

// The job fields DLQ evaluation reads. Execution status is not among them, so
// both stored rows and display listings can be evaluated.
export type DlqCandidate = Pick<JobRecord, "id" | "accountId" | "briefId" | "type" | "metadata">;

// A webhook dispatch is DLQ-bound when it has used its whole retry budget
// (attempt rows, one per execution) and its latest attempt failed.
export class DlqInspector {
  constructor(
    private readonly attempts: DeliveryAttemptReader,
    private readonly budgets: RetryBudgetPolicy,
  ) {}

  async evaluate(job: DlqCandidate): Promise<DlqBoundEndpoint | null> {
    if (job.type !== "dispatch_webhook") {
      return null;
    }

    const retryBudget = this.budgets.budgetFor(job.accountId);
    const attemptCount = await this.attempts.countByDeliveryJob(job.id);
    if (attemptCount < retryBudget) {
      return null;
    }

    const lastAttempts = await this.attempts.listLatestByDeliveryJob(job.id, DLQ_LAST_ATTEMPTS_SHOWN);
    if (lastAttempts[0]?.status !== "failed") {
      return null;
    }

    return {
      deliveryJobId: job.id,
      accountId: job.accountId,
      briefId: job.briefId,
      endpointUrl: job.metadata.endpointUrl,
      attemptCount,
      retryBudget,
      lastAttempts,
    };
  }

  async findDlqBound(jobs: readonly DlqCandidate[]): Promise<DlqBoundEndpoint[]> {
    const evaluated = await Promise.all(jobs.map((job) => this.evaluate(job)));
    return evaluated.filter((endpoint): endpoint is DlqBoundEndpoint => endpoint !== null);
  }

  async summarize(jobs: readonly DlqCandidate[]): Promise<DlqSummary> {
    const endpoints = await this.findDlqBound(jobs);
    return { count: endpoints.length, endpoints };
  }
}
