import type { DeadLetterQueue } from "../domain/dead-letter-queue";
import type { DeliveryAttempt } from "../domain/delivery";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobMetadata, JobRecord } from "../domain/job";
import type { JobRecordView } from "./job-record-service";
import { JobRecordService } from "./job-record-service";
import type { RetryBudgetPolicy } from "./retry-budget-policy";

export interface DlqEndpointSummary {
  endpointUrl: string;
  attemptBodies: string[];
}

export interface DlqSummary {
  pastBudgetCount: number;
  endpoints: DlqEndpointSummary[];
}

export interface JobListing {
  jobs: JobRecordView[];
  dlq: DlqSummary;
}

const DRAIN_METADATA: JobMetadata = {
  customerId: "tessera-dlq",
  subscriptionId: "drain_dlq",
  endpointUrl: "https://hooks.tessera.invalid/dlq",
  eventType: "delivery.dlq.drain",
  payloadHash: "sha256:dlq",
};

export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly budgets: RetryBudgetPolicy,
    private readonly dlq: DeadLetterQueue,
  ) {}

  async process(accountId: string, briefId: string, workerId = "drain-dlq"): Promise<JobRecord> {
    const budget = this.budgets.budgetFor(accountId);
    const jobs = await this.jobRecords.listByBrief(briefId);

    for (const job of jobs) {
      if (job.type !== "dispatch_webhook") {
        continue;
      }

      const history = await this.attempts.listByDeliveryJobId(job.id);
      if (!isPastRetryBudget(history, budget)) {
        continue;
      }

      await this.dlq.move({
        accountId,
        briefId,
        dispatchJobId: job.id,
        endpointUrl: job.metadata.endpointUrl,
      });
    }

    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId,
      briefId,
      type: "drain_dlq",
      metadata: DRAIN_METADATA,
    });

    return this.jobRecords.markCompleted(drainJob.id, { workerId });
  }

  async listJobs(
    briefId: string,
    options?: { status?: string | undefined; now?: Date | undefined },
  ): Promise<JobListing> {
    const now = options?.now ?? new Date();
    const jobs = await this.jobRecords.listByBrief(briefId, now);
    const entries = await this.dlq.listByBrief(briefId);
    const dlqJobIds = new Set(entries.map((entry) => entry.dispatchJobId));

    const endpoints: DlqEndpointSummary[] = [];
    for (const entry of entries) {
      const history = await this.attempts.listByDeliveryJobId(entry.dispatchJobId);
      endpoints.push({
        endpointUrl: entry.endpointUrl,
        attemptBodies: history.slice(-3).map((attempt) => attempt.errorBody ?? ""),
      });
    }

    const filtered =
      options?.status === "dlq" ? jobs.filter((job) => dlqJobIds.has(job.id)) : jobs;

    return {
      jobs: filtered,
      dlq: {
        pastBudgetCount: uniqueEndpointCount(endpoints),
        endpoints,
      },
    };
  }
}

export function isPastRetryBudget(attempts: DeliveryAttempt[], budget: number): boolean {
  if (attempts.length < budget) {
    return false;
  }
  const latest = attempts[attempts.length - 1];
  return latest !== undefined && latest.status !== "completed";
}

function uniqueEndpointCount(endpoints: DlqEndpointSummary[]): number {
  return new Set(endpoints.map((endpoint) => endpoint.endpointUrl)).size;
}
