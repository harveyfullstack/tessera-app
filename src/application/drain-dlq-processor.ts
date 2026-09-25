import type { JobRecord, JobStatus } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export const DEFAULT_RETRY_BUDGET = 8;

export interface RetryBudgetConfig {
  defaultAttempts?: number;
  perAccount?: Readonly<Record<string, number>>;
}

export interface DlqEndpoint {
  jobId: string;
  endpointUrl: string;
  attemptBodies: string[];
}

export interface DlqJobView extends Omit<JobRecord, "status"> {
  status: JobStatus | "dlq";
  dlq: { attemptBodies: string[] } | null;
}

export interface BriefJobsView {
  jobs: DlqJobView[];
  dlq: {
    pastBudgetCount: number;
    endpoints: DlqEndpoint[];
  };
}

export class DrainDlqProcessor {
  private readonly defaultAttempts: number;
  private readonly perAccount: Readonly<Record<string, number>>;

  constructor(
    private readonly jobs: JobRecordService,
    config: RetryBudgetConfig = {},
  ) {
    this.defaultAttempts = config.defaultAttempts ?? DEFAULT_RETRY_BUDGET;
    this.perAccount = config.perAccount ?? {};
    this.validateBudgets();
  }

  async process(accountId: string, briefId: string): Promise<JobRecord[]> {
    const records = await this.jobs.listByBrief(briefId);
    const existingParentIds = new Set(
      records
        .filter((record) => record.type === "drain_dlq" && record.parentJobId)
        .map((record) => record.parentJobId)
        .filter((id): id is string => id !== undefined),
    );
    const drained: JobRecord[] = [];

    for (const record of records) {
      if (
        record.accountId !== accountId ||
        record.type !== "dispatch_webhook" ||
        record.status !== "failed" ||
        existingParentIds.has(record.id)
      ) {
        continue;
      }

      const attempts = await this.jobs.listAttempts(record.id);
      const terminalAttempts = attempts.filter(
        (attempt) => attempt.status === "failed" || attempt.status === "completed",
      );
      if (
        terminalAttempts.filter((attempt) => attempt.status === "failed").length <
          this.retryBudgetFor(accountId) ||
        terminalAttempts.some((attempt) => attempt.status !== "failed")
      ) {
        continue;
      }

      const entry = await this.jobs.ensureDlqEntry({
        accountId: record.accountId,
        briefId: record.briefId,
        taskId: record.taskId,
        parentJobId: record.id,
        type: "drain_dlq",
        metadata: record.metadata,
      });
      existingParentIds.add(record.id);

      if (entry.status === "queued") {
        drained.push(await this.jobs.markCompleted(entry.id, {}));
      } else {
        drained.push(entry);
      }
    }

    return drained;
  }

  async isDeadLettered(accountId: string, briefId: string, jobId: string): Promise<boolean> {
    const records = await this.jobs.listByBrief(briefId);
    return records.some(
      (record) =>
        record.accountId === accountId &&
        record.type === "drain_dlq" &&
        record.parentJobId === jobId,
    );
  }

  async listByBrief(
    accountId: string,
    briefId: string,
    statusFilter?: string | null,
  ): Promise<BriefJobsView> {
    const records = (await this.jobs.listByBrief(briefId)).filter(
      (record) => record.accountId === accountId,
    );
    const endpointJobs = records.filter((record) => record.type === "dispatch_webhook");
    const deadLetterEntries = new Set(
      records
        .filter((record) => record.type === "drain_dlq" && record.parentJobId)
        .map((record) => record.parentJobId)
        .filter((id): id is string => id !== undefined),
    );

    const endpoints: DlqEndpoint[] = [];
    const dlqBodiesByJob = new Map<string, string[]>();
    for (const record of endpointJobs) {
      if (!deadLetterEntries.has(record.id)) {
        continue;
      }

      const attempts = await this.jobs.listAttempts(record.id);
      const attemptBodies = attempts
        .filter((attempt) => attempt.status === "failed" || attempt.status === "completed")
        .slice(-3)
        .flatMap((attempt) => (attempt.errorBody === undefined ? [] : [attempt.errorBody]));
      dlqBodiesByJob.set(record.id, attemptBodies);
      endpoints.push({
        jobId: record.id,
        endpointUrl: record.metadata.endpointUrl,
        attemptBodies,
      });
    }

    const jobs = records
      .map((record): DlqJobView => {
        const attemptBodies = dlqBodiesByJob.get(record.id);
        return {
          ...record,
          status: attemptBodies === undefined ? record.status : "dlq",
          dlq: attemptBodies === undefined ? null : { attemptBodies },
        };
      })
      .filter((record) => {
        if (!statusFilter) {
          return true;
        }
        return record.status === statusFilter;
      });

    return {
      jobs,
      dlq: {
        pastBudgetCount: endpoints.length,
        endpoints,
      },
    };
  }

  private retryBudgetFor(accountId: string): number {
    return this.perAccount[accountId] ?? this.defaultAttempts;
  }

  private validateBudgets(): void {
    const budgets = [this.defaultAttempts, ...Object.values(this.perAccount)];
    if (budgets.some((attempts) => !Number.isInteger(attempts) || attempts < 1)) {
      throw new RangeError("Retry budgets must be positive integer attempt counts");
    }
  }
}

export function parseAccountRetryBudgets(value: string | undefined): Readonly<Record<string, number>> {
  if (!value) {
    return {};
  }

  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("WEBHOOK_RETRY_BUDGETS must be a JSON object of account IDs to attempt counts");
  }

  const budgets: Record<string, number> = {};
  for (const [accountId, attempts] of Object.entries(parsed)) {
    if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) {
      throw new TypeError(`Retry budget for account ${accountId} must be a positive integer`);
    }
    budgets[accountId] = attempts;
  }
  return budgets;
}
