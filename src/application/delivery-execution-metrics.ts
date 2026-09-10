import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

export const DLQ_BOOKKEEPING_MARKER = "Moved to dead letter queue";

export function isDlqBookkeepingAttempt(attempt: DeliveryAttemptRecord): boolean {
  return (
    attempt.errorBody?.includes(DLQ_BOOKKEEPING_MARKER) === true ||
    attempt.errorBody?.startsWith("DLQ:") === true
  );
}

export function isFailedDeliveryExecution(attempt: DeliveryAttemptRecord): boolean {
  return attempt.status === "failed" && !isDlqBookkeepingAttempt(attempt);
}

export function isDiagnosticDeliveryAttempt(attempt: DeliveryAttemptRecord): boolean {
  return (
    (attempt.status === "failed" || attempt.status === "completed") &&
    !isDlqBookkeepingAttempt(attempt)
  );
}

export function countFailedDeliveryExecutions(attempts: DeliveryAttemptRecord[]): number {
  return attempts.filter(isFailedDeliveryExecution).length;
}

export function countTerminalDeliveryAttempts(attempts: DeliveryAttemptRecord[]): number {
  return attempts.filter(isDiagnosticDeliveryAttempt).length;
}

export function legacyFailedExecutionCount(job: JobRecord): number {
  return job.retryCount;
}

export function legacyTerminalAttemptCount(job: JobRecord): number {
  if (job.status === "completed") {
    return job.retryCount + 1;
  }
  if (job.status === "failed") {
    return Math.max(job.retryCount, 1);
  }
  return job.retryCount;
}

/** Row count the 002 backfill writes for a legacy jobs row. */
export function isJobInDlq(job: JobRecord, failedExecutionCount: number, budget: number): boolean {
  if (job.status === "completed") {
    return false;
  }

  const effectiveFailed = Math.max(failedExecutionCount, legacyFailedExecutionCount(job));
  return effectiveFailed >= budget;
}

export function isJobAlreadyDrained(job: JobRecord): boolean {
  return job.errorMessage?.includes(DLQ_BOOKKEEPING_MARKER) === true;
}

export function legacyBackfillRowCount(job: JobRecord): number {
  if (job.status === "queued" && job.retryCount === 0) {
    return 0;
  }
  if (
    job.status === "queued" ||
    job.status === "completed" ||
    job.status === "running" ||
    job.status === "cancelled"
  ) {
    return job.retryCount + 1;
  }
  return Math.max(job.retryCount, 1);
}
