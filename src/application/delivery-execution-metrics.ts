import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

export function legacyBackfillAttemptCount(job: JobRecord): number {
  if (job.status === "queued" && job.retryCount === 0) {
    return 0;
  }
  if (job.status === "failed") {
    return Math.max(job.retryCount, 1);
  }
  return job.retryCount + 1;
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

export function isDiagnosticDeliveryAttempt(attempt: DeliveryAttemptRecord): boolean {
  return attempt.status === "failed" || attempt.status === "completed";
}

export function countTerminalDeliveryAttempts(attempts: DeliveryAttemptRecord[]): number {
  return attempts.filter(isDiagnosticDeliveryAttempt).length;
}
