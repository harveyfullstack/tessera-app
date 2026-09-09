import { JobRecordService } from "./job-record-service";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { AccountRetryBudget } from "./account-retry-budget";
import type { JobMetadata, JobRecord } from "../domain/job";

export interface DrainDlqRequest {
  accountId: string;
  briefId: string;
}

export interface DlqEndpointSummary {
  endpointUrl: string;
  pastBudgetCount: number;
  lastAttempts: Array<{
    attemptNumber: number;
    status: string;
    errorBody?: string | undefined;
    responseStatus?: number | undefined;
  }>;
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly attemptRpc: DeliveryAttemptRpc,
    private readonly retryBudgets: AccountRetryBudget,
  ) {}

  async ensureDrainJob(accountId: string, briefId: string): Promise<JobRecord> {
    return this.jobRecords.ensureJobRecord({
      accountId,
      briefId,
      type: "drain_dlq",
      metadata: {
        customerId: "system",
        subscriptionId: "dlq-drain",
        endpointUrl: "internal://dlq-drain",
        eventType: "dlq.drain",
        payloadHash: "sha256:dlq",
      },
    });
  }

  async drain(request: DrainDlqRequest): Promise<JobRecord> {
    const drainJob = await this.ensureDrainJob(request.accountId, request.briefId);
    await this.jobRecords.markRunning(drainJob.id, "dlq-drainer");

    const jobs = await this.jobRecords.listByBrief(request.briefId);
    const budget = this.retryBudgets.getRetryBudget(request.accountId);

    for (const job of jobs) {
      if (job.type !== "dispatch_webhook") {
        continue;
      }

      const attemptCount = await this.attemptRpc.countAttempts(job.id);
      const effectiveAttempts = Math.max(attemptCount, job.retryCount);
      if (effectiveAttempts >= budget) {
        await this.jobRecords.markFailed(
          job.id,
          `Moved to dead letter queue after ${effectiveAttempts} attempts`,
          {
            errorBody: `DLQ: exceeded retry budget of ${budget}`,
          },
        );
      }
    }

    return this.jobRecords.markCompleted(drainJob.id, {
      workerId: "dlq-drainer",
      attemptNumber: 1,
    });
  }

  async buildDlqSummaries(briefId: string, accountId: string): Promise<DlqEndpointSummary[]> {
    const jobs = await this.jobRecords.listByBrief(briefId);
    const budget = this.retryBudgets.getRetryBudget(accountId);
    const byEndpoint = new Map<string, DlqEndpointSummary>();

    for (const job of jobs) {
      if (job.type !== "dispatch_webhook") {
        continue;
      }

      const attempts = await this.attemptRpc.listAttempts(job.id);
      const effectiveAttempts = Math.max(attempts.length, job.retryCount);
      if (effectiveAttempts < budget) {
        continue;
      }

      const endpointUrl = job.metadata.endpointUrl;
      const existing = byEndpoint.get(endpointUrl) ?? {
        endpointUrl,
        pastBudgetCount: 0,
        lastAttempts: [],
      };

      existing.pastBudgetCount += 1;
      const attemptBodies = attempts
        .slice(0, 3)
        .map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          errorBody: attempt.errorBody,
          responseStatus: attempt.responseStatus,
        }));

      existing.lastAttempts = mergeLatestAttempts(existing.lastAttempts, attemptBodies);
      byEndpoint.set(endpointUrl, existing);
    }

    return [...byEndpoint.values()];
  }
}

function mergeLatestAttempts(
  current: DlqEndpointSummary["lastAttempts"],
  incoming: DlqEndpointSummary["lastAttempts"],
): DlqEndpointSummary["lastAttempts"] {
  const merged = [...current, ...incoming]
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .slice(0, 3);
  return merged;
}
