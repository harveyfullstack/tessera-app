import { DeliverySchemaMigrationError } from "./errors";
import type { JobRecord } from "./job";

type LegacyAttemptFields = Pick<JobRecord, "status" | "retryCount" | "startedAt">;

// Phase 1 stored one mutable execution slot. retry() increments retryCount for the
// failed attempt itself, before markFailed. A bare markFailed leaves retryCount at 0
// and still represents one attempt. Success and in-flight runs do not increment.
export function legacyJobAttemptCount(job: LegacyAttemptFields): number {
  if (!Number.isInteger(job.retryCount) || job.retryCount < 0) {
    throw new DeliverySchemaMigrationError("retryCount must be a non-negative integer");
  }

  if (job.status === "queued" && job.startedAt === undefined) {
    return job.retryCount;
  }

  if (job.status === "failed") {
    return Math.max(job.retryCount, 1);
  }

  return job.retryCount + 1;
}
