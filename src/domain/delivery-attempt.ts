import type { JobStatus } from "./job";

// Mirrors delivery_attempts (sql/migrations/002_split_delivery_jobs_and_attempts.sql).
// Rows are append-only: one row per execution transition.
export type DeliveryAttemptStatus = JobStatus;

export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  status: DeliveryAttemptStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  backfilled: boolean;
  createdAt: Date;
}

export type NewDeliveryAttempt = Omit<DeliveryAttempt, "id" | "backfilled" | "createdAt">;

// The latest run: the highest attempt_number that is not 'queued'. 'queued'
// rows are scheduled retries, not runs, and can land after a run's terminal
// row, so MAX(attempt_number) alone may point at a retry that has not run yet.
export function latestRunAttempt(
  attempts: readonly DeliveryAttempt[],
): DeliveryAttempt | undefined {
  return attempts.reduce<DeliveryAttempt | undefined>(
    (latest, attempt) =>
      attempt.status !== "queued" && (!latest || attempt.attemptNumber > latest.attemptNumber)
        ? attempt
        : latest,
    undefined,
  );
}
