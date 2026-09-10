import {
  DLQ_BOOKKEEPING_MARKER,
  isDiagnosticDeliveryAttempt,
  isJobAlreadyDrained,
  isJobInDlq,
  legacyFailedExecutionCount,
} from "./delivery-execution-metrics";
import { JobRecordService } from "./job-record-service";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { AccountRetryBudget } from "./account-retry-budget";
import type { DeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";
import type { JobRecord } from "../domain/job";

export interface DrainDlqRequest {
  accountId: string;
  briefId: string;
}

export interface DlqEndpointSummary {
  endpointUrl: string;
  pastBudgetCount: number;
  lastAttemptBodies: string[];
  lastAttempts: Array<{
    attemptNumber: number;
    status: string;
    errorBody?: string | undefined;
    responseStatus?: number | undefined;
  }>;
}

export interface DlqSummary {
  pastBudgetCount: number;
  endpoints: DlqEndpointSummary[];
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly attemptRpc: DeliveryAttemptRpc,
    private readonly retryBudgets: AccountRetryBudget,
    private readonly rollbackFlags: DeliveryAttemptRollbackFlags,
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

      if (isJobAlreadyDrained(job)) {
        continue;
      }

      const failedCount = this.rollbackFlags.isRollbackEnabled(request.accountId)
        ? legacyFailedExecutionCount(job)
        : await this.attemptRpc.countFailedExecutions(job.id);

      if (!isJobInDlq(job, failedCount, budget)) {
        continue;
      }

      await this.jobRecords.markFailed(
        job.id,
        `${DLQ_BOOKKEEPING_MARKER} after ${failedCount} failed delivery executions`,
        {
          errorBody: `DLQ: exceeded retry budget of ${budget}`,
        },
      );
    }

    return this.jobRecords.markCompleted(drainJob.id, {
      workerId: "dlq-drainer",
    });
  }

  async buildDlqSummary(briefId: string, accountId: string): Promise<DlqSummary> {
    const jobs = await this.jobRecords.listByBrief(briefId);
    const byEndpoint = new Map<string, DlqEndpointSummary>();

    for (const job of jobs) {
      if (job.type !== "dispatch_webhook") {
        continue;
      }

      if (!(await this.jobRecords.isInDlq(job))) {
        continue;
      }

      const endpointUrl = job.metadata.endpointUrl;
      const existing = byEndpoint.get(endpointUrl) ?? {
        endpointUrl,
        pastBudgetCount: 0,
        lastAttemptBodies: [],
        lastAttempts: [],
      };

      existing.pastBudgetCount += 1;

      const attempts = await this.attemptRpc.listAttempts(job.id);
      const diagnosticAttempts = attempts
        .filter(isDiagnosticDeliveryAttempt)
        .slice(0, 3)
        .map((attempt) => ({
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          errorBody: attempt.errorBody,
          responseStatus: attempt.responseStatus,
        }));

      existing.lastAttempts = mergeLatestAttempts(existing.lastAttempts, diagnosticAttempts);
      existing.lastAttemptBodies = existing.lastAttempts
        .map((attempt) => attempt.errorBody)
        .filter((body): body is string => typeof body === "string");
      byEndpoint.set(endpointUrl, existing);
    }

    const endpoints = [...byEndpoint.values()];
    return {
      pastBudgetCount: endpoints.reduce((sum, endpoint) => sum + endpoint.pastBudgetCount, 0),
      endpoints,
    };
  }
}

function mergeLatestAttempts(
  current: DlqEndpointSummary["lastAttempts"],
  incoming: DlqEndpointSummary["lastAttempts"],
): DlqEndpointSummary["lastAttempts"] {
  return [...current, ...incoming]
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .slice(0, 3);
}
