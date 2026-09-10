import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

export function isDiagnosticDeliveryAttempt(attempt: DeliveryAttemptRecord): boolean {
  return attempt.status === "failed" || attempt.status === "completed";
}

export function countFailedDeliveryExecutions(attempts: DeliveryAttemptRecord[]): number {
  return attempts.filter((attempt) => attempt.status === "failed").length;
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
