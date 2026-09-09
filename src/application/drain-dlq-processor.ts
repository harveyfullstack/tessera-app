import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobMetadata, JobRecord } from "../domain/job";
import { AccountRetryBudget, DEFAULT_RETRY_BUDGET } from "./account-retry-budget";
import { JobRecordService } from "./job-record-service";

export interface DlqEndpoint {
  endpointUrl: string;
  attemptBodies: string[];
}

export interface DlqField {
  pastBudgetCount: number;
  endpoints: DlqEndpoint[];
}

export interface DrainDlqResult {
  drainJob: JobRecord | null;
  dlq: DlqField;
  movedJobIds: string[];
}

const DRAIN_METADATA: JobMetadata = {
  customerId: "tessera-dlq",
  subscriptionId: "drain_dlq",
  endpointUrl: "dlq://dead-letter",
  eventType: "delivery.dlq",
  payloadHash: "sha256:dlq",
};

function latestAttempt(attempts: DeliveryAttempt[]): DeliveryAttempt | undefined {
  return attempts.reduce<DeliveryAttempt | undefined>((current, attempt) => {
    if (!current || attempt.attemptNumber > current.attemptNumber) {
      return attempt;
    }

    return current;
  }, undefined);
}

function terminalAttempts(attempts: DeliveryAttempt[]): DeliveryAttempt[] {
  return attempts.filter((attempt) => attempt.status === "failed" || attempt.status === "completed");
}

export function isPastRetryBudget(
  attempts: DeliveryAttempt[],
  budget: number = DEFAULT_RETRY_BUDGET,
): boolean {
  const consumed = terminalAttempts(attempts).length;
  if (consumed < budget) {
    return false;
  }

  const latest = latestAttempt(attempts);
  return latest !== undefined && latest.status !== "completed";
}

export function lastThreeAttemptBodies(attempts: DeliveryAttempt[]): string[] {
  return [...terminalAttempts(attempts)]
    .sort((a, b) => {
      const byNumber = b.attemptNumber - a.attemptNumber;
      if (byNumber !== 0) {
        return byNumber;
      }

      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, 3)
    .map((attempt) => attempt.errorBody ?? "");
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly budgets: AccountRetryBudget = new AccountRetryBudget(),
  ) {}

  retryBudget(accountId: string): number {
    return this.budgets.get(accountId);
  }

  async collectDlq(accountId: string, briefId: string): Promise<DlqField> {
    const grouped = await this.groupWebhookAttempts(briefId);
    const budget = this.budgets.get(accountId);
    const endpoints: DlqEndpoint[] = [];

    for (const [endpointUrl, attempts] of grouped) {
      if (!isPastRetryBudget(attempts, budget)) {
        continue;
      }

      endpoints.push({
        endpointUrl,
        attemptBodies: lastThreeAttemptBodies(attempts),
      });
    }

    endpoints.sort((a, b) => a.endpointUrl.localeCompare(b.endpointUrl));
    return {
      pastBudgetCount: endpoints.length,
      endpoints,
    };
  }

  async isDlqBound(accountId: string, job: JobRecord): Promise<boolean> {
    if (job.type !== "dispatch_webhook") {
      return false;
    }

    const attempts = await this.jobRecords.listAttempts(job.id);
    return isPastRetryBudget(attempts, this.budgets.get(accountId));
  }

  async drain(accountId: string, briefId: string): Promise<DrainDlqResult> {
    const webhookJobs = (await this.jobRecords.listByBrief(briefId)).filter(
      (job) => job.type === "dispatch_webhook",
    );
    const moved: JobRecord[] = [];

    for (const job of webhookJobs) {
      if (await this.isDlqBound(accountId, job)) {
        moved.push(job);
      }
    }

    const dlq = await this.collectDlq(accountId, briefId);
    if (moved.length === 0) {
      return { drainJob: null, dlq, movedJobIds: [] };
    }

    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId,
      briefId,
      type: "drain_dlq",
      metadata: {
        ...DRAIN_METADATA,
        endpointUrl: moved[0]?.metadata.endpointUrl ?? DRAIN_METADATA.endpointUrl,
      },
    });

    await this.jobRecords.markRunning(drainJob.id, "drain-dlq-processor");
    const completed = await this.jobRecords.markCompleted(drainJob.id, {
      workerId: "drain-dlq-processor",
      responseStatus: 200,
      errorBody: `moved ${moved.length} endpoint(s) past the retry budget`,
    });

    return {
      drainJob: completed,
      dlq,
      movedJobIds: moved.map((job) => job.id),
    };
  }

  private async groupWebhookAttempts(briefId: string): Promise<Map<string, DeliveryAttempt[]>> {
    const grouped = new Map<string, DeliveryAttempt[]>();
    const jobs = (await this.jobRecords.listByBrief(briefId)).filter(
      (job) => job.type === "dispatch_webhook",
    );

    for (const job of jobs) {
      const attempts = await this.jobRecords.listAttempts(job.id);
      const endpointUrl = job.metadata.endpointUrl;
      const existing = grouped.get(endpointUrl) ?? [];
      existing.push(...attempts);
      grouped.set(endpointUrl, existing);
    }

    return grouped;
  }
}
