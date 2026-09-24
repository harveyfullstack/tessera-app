import type { DeliveryAttempt } from "./delivery-attempt";
import type { JobDisplayStatus } from "./job";

// A running attempt whose started_at is more than this old is shown as stuck.
export const STUCK_ATTEMPT_THRESHOLD_MS = 5 * 60 * 1000;

// Display status from the latest attempt (MAX(attempt_number)) of a delivery
// job. No attempts means the job has never executed, so it is queued.
export function deriveAttemptDisplayStatus(
  latest: DeliveryAttempt | null,
  now: Date,
): JobDisplayStatus {
  if (!latest) {
    return "queued";
  }

  if (
    latest.status === "running" &&
    now.getTime() - latest.startedAt.getTime() > STUCK_ATTEMPT_THRESHOLD_MS
  ) {
    return "stuck";
  }

  return latest.status;
}
