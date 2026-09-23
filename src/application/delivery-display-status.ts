import { latestRunAttempt, type DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobStatus } from "../domain/job";

export type JobDisplayStatus = JobStatus | "stuck";

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

// A run whose 'running' row started longer ago than this is shown as stuck.
export const STUCK_RUN_THRESHOLD_MS = 5 * 60 * 1000;

// UI status derived from delivery_attempts. The latest run is chosen with
// latestRunAttempt, the same rule DeadLetterQueueInspector uses, so a retry
// queued after a failed run still displays the run's 'failed'. A job with no
// runs yet (no attempts, or only a queued retry) displays 'queued'.
export function deriveDisplayStatus(
  attempts: readonly DeliveryAttempt[],
  now: Date,
): JobDisplayStatus {
  const latest = latestRunAttempt(attempts);
  if (!latest) {
    return "queued";
  }
  if (latest.status === "running" && isStuck(latest, now)) {
    return "stuck";
  }
  return latest.status;
}

function isStuck(run: DeliveryAttempt, now: Date): boolean {
  return (
    run.startedAt !== undefined &&
    now.getTime() - run.startedAt.getTime() > STUCK_RUN_THRESHOLD_MS
  );
}
