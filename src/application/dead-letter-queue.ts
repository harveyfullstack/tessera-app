import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

export const DEFAULT_RETRY_BUDGET = 8;
export const DLQ_ATTEMPT_BODY_LIMIT = 3;

/** Retry budget in delivery tries: a default plus per-account overrides. */
export interface RetryBudgetConfig {
  defaultBudget: number;
  accountBudgets: ReadonlyMap<string, number>;
}

export const DEFAULT_RETRY_BUDGET_CONFIG: RetryBudgetConfig = {
  defaultBudget: DEFAULT_RETRY_BUDGET,
  accountBudgets: new Map<string, number>(),
};

export function retryBudgetFor(config: RetryBudgetConfig, accountId: string): number {
  return config.accountBudgets.get(accountId) ?? config.defaultBudget;
}

/** An attempt body, keyed only by (deliveryJobId, attemptNumber). */
export interface DlqAttemptBody {
  deliveryJobId: string;
  attemptNumber: number;
  responseStatus?: number | undefined;
  errorBody: string;
}

export interface DlqSummary {
  /** The job's existing metadata.endpointUrl; there is no endpoint column. */
  endpointUrl: string;
  retryBudget: number;
  /** Real delivery tries (status='running' attempts) once past the budget. */
  pastBudgetCount: number;
  /** Most recent attempt bodies, oldest first, at most DLQ_ATTEMPT_BODY_LIMIT. */
  lastAttemptBodies: DlqAttemptBody[];
}

/**
 * Each RPC call appends one attempt row (running, queued, failed, completed),
 * so attempt_number is not a try count. A delivery try is one running row.
 */
export function countDeliveryTries(attempts: readonly DeliveryAttempt[]): number {
  return attempts.filter((attempt) => attempt.status === "running").length;
}

function latestOutcome(attempts: readonly DeliveryAttempt[]): DeliveryAttempt | undefined {
  return [...attempts]
    .reverse()
    .find((attempt) => attempt.status === "completed" || attempt.status === "failed");
}

/**
 * A job is DLQ-bound when its delivery tries have used the whole budget and
 * its latest outcome is a failure. Derived from append-only attempts only, so
 * moving a job to the DLQ never updates or adds a status on attempt rows.
 *
 * @param attempts the job's attempts ordered by attemptNumber ascending
 */
export function summarizeDlq(
  job: JobRecord,
  attempts: readonly DeliveryAttempt[],
  retryBudget: number,
): DlqSummary | null {
  const tries = countDeliveryTries(attempts);
  if (tries < retryBudget || latestOutcome(attempts)?.status !== "failed") {
    return null;
  }

  const lastAttemptBodies = attempts
    .filter((attempt) => attempt.errorBody !== undefined)
    .slice(-DLQ_ATTEMPT_BODY_LIMIT)
    .map((attempt) => ({
      deliveryJobId: attempt.deliveryJobId,
      attemptNumber: attempt.attemptNumber,
      responseStatus: attempt.responseStatus,
      errorBody: attempt.errorBody ?? "",
    }));

  return {
    endpointUrl: job.metadata.endpointUrl,
    retryBudget,
    pastBudgetCount: tries,
    lastAttemptBodies,
  };
}
