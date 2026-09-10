import type { JobRepository } from "../domain/job-repository";
import type { DlqEndpointSummary, JobRecord } from "../domain/job";
import { AccountRetryBudgets } from "./account-retry-budgets";
import { JobRecordService } from "./job-record-service";

export interface DlqField {
  pastBudgetCount: number;
  endpoints: DlqEndpointSummary[];
}

export interface JobsListResponse {
  jobs: JobRecord[];
  dlq: DlqField;
}

const DRAIN_DLQ_METADATA = {
  customerId: "dlq",
  subscriptionId: "drain_dlq",
  endpointUrl: "dlq://dead-letter",
  eventType: "delivery.dlq",
  payloadHash: "sha256:dlq",
} as const;

export class DrainDlqProcessor {
  constructor(
    private readonly jobs: JobRepository,
    private readonly jobRecords: JobRecordService,
    private readonly budgets: AccountRetryBudgets = new AccountRetryBudgets(),
  ) {}

  retryBudgetFor(accountId: string): number {
    return this.budgets.get(accountId);
  }

  setRetryBudget(accountId: string, budget: number): void {
    this.budgets.set(accountId, budget);
  }

  async summarize(accountId: string, briefId: string): Promise<DlqField> {
    const endpoints: DlqEndpointSummary[] = [];
    const budget = this.budgets.get(accountId);
    const rows = (await this.jobs.listByBrief(briefId)).filter(
      (job) => job.accountId === accountId && job.type === "dispatch_webhook",
    );

    for (const job of rows) {
      const attempts = await this.jobs.listAttempts(job.id);
      const latest = attempts[0];
      if (attempts.length < budget || latest === undefined || latest.status === "completed") {
        continue;
      }

      endpoints.push({
        endpointUrl: job.metadata.endpointUrl,
        jobId: job.id,
        lastAttemptBodies: attempts.slice(0, 3).map((attempt) => attempt.errorBody ?? ""),
      });
    }

    return {
      pastBudgetCount: endpoints.length,
      endpoints,
    };
  }

  async process(accountId: string, briefId: string): Promise<JobRecord> {
    const dlq = await this.summarize(accountId, briefId);
    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId,
      briefId,
      type: "drain_dlq",
      metadata: {
        ...DRAIN_DLQ_METADATA,
        dlqEndpoints: dlq.endpoints,
      },
    });

    return this.jobRecords.markCompleted(drainJob.id, {
      responseStatus: 200,
      errorBody: `${dlq.pastBudgetCount} endpoints moved to dlq`,
    });
  }

  async listJobs(accountId: string, briefId: string, status?: string): Promise<JobsListResponse> {
    const dlq = await this.summarize(accountId, briefId);
    const rows = await this.jobRecords.listByBrief(briefId);

    if (status === "dlq") {
      const dlqJobIds = new Set(dlq.endpoints.map((endpoint) => endpoint.jobId));
      return {
        jobs: rows.filter((job) => dlqJobIds.has(job.id)),
        dlq,
      };
    }

    return { jobs: rows, dlq };
  }
}
