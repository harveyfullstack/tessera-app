import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRecord, JobStatus } from "../domain/job";

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

export function isJobAlreadyDrained(job: JobRecord): boolean {
  return job.errorMessage?.includes(DLQ_BOOKKEEPING_MARKER) === true;
}

export function countTerminalDeliveryAttempts(attempts: DeliveryAttemptRecord[]): number {
  return attempts.filter(isDiagnosticDeliveryAttempt).length;
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

export function backfillAttemptRowCount(job: JobRecord): number {
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

export function backfillAttemptStatuses(job: JobRecord): JobStatus[] {
  const count = backfillAttemptRowCount(job);
  if (count === 0) {
    return [];
  }

  return Array.from({ length: count }, (_, index) => {
    const attemptNumber = index + 1;
    if (attemptNumber === count) {
      return job.status;
    }
    return "failed";
  });
}
