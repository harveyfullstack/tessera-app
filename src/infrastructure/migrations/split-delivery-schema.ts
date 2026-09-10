import { randomUUID } from "crypto";
import type { DeliveryAttempt, JobRecord, JobStatus } from "../../domain/job";

export function legacyAttemptCount(job: Pick<JobRecord, "status" | "retryCount">): number {
  if (job.status === "queued" && job.retryCount === 0) {
    return 0;
  }
  if (job.status === "queued") {
    return job.retryCount;
  }
  return job.retryCount + 1;
}

export interface SplitDeliverySchemaResult {
  deliveryJobs: JobRecord[];
  attempts: DeliveryAttempt[];
  remappedIds: Map<string, string>;
}

function intentKey(job: Pick<JobRecord, "accountId" | "briefId" | "type">): string {
  return `${job.accountId}\0${job.briefId}\0${job.type}`;
}

/**
 * Collapse duplicate jobs intent rows onto the earliest
 * (account_id, brief_id, type) winner and reconstruct append-only attempts
 * so old/new attempt counts match per delivery job and in aggregate.
 */
export function splitDeliverySchema(jobs: JobRecord[]): SplitDeliverySchemaResult {
  const sorted = [...jobs].sort((a, b) => {
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    return created !== 0 ? created : a.id.localeCompare(b.id);
  });

  const canonicalByKey = new Map<string, JobRecord>();
  const remappedIds = new Map<string, string>();

  for (const job of sorted) {
    const key = intentKey(job);
    const canonical = canonicalByKey.get(key);
    if (!canonical) {
      canonicalByKey.set(key, job);
      remappedIds.set(job.id, job.id);
      continue;
    }
    remappedIds.set(job.id, canonical.id);
  }

  const attempts: DeliveryAttempt[] = [];
  const nextNumber = new Map<string, number>();

  for (const job of sorted) {
    const deliveryJobId = remappedIds.get(job.id);
    if (!deliveryJobId) {
      continue;
    }

    const count = legacyAttemptCount(job);
    let attemptNumber = nextNumber.get(deliveryJobId) ?? 1;

    for (let attemptInSource = 1; attemptInSource <= count; attemptInSource += 1) {
      const isLatestOnSource = attemptInSource === count;
      attempts.push({
        id: randomUUID(),
        deliveryJobId,
        attemptNumber,
        workerId: isLatestOnSource ? job.workerId : undefined,
        status: isLatestOnSource ? job.status : "failed",
        errorBody: isLatestOnSource ? job.errorMessage : undefined,
        startedAt: isLatestOnSource ? job.startedAt : undefined,
        createdAt: job.updatedAt,
      });
      attemptNumber += 1;
    }

    nextNumber.set(deliveryJobId, attemptNumber);
  }

  const deliveryJobs = [...canonicalByKey.values()].map((job) => {
    const parentJobId = job.parentJobId ? remappedIds.get(job.parentJobId) : undefined;
    return parentJobId && parentJobId !== job.parentJobId
      ? { ...job, parentJobId }
      : job;
  });

  return { deliveryJobs, attempts, remappedIds };
}

export function assertAttemptCountParity(
  jobs: JobRecord[],
  split: SplitDeliverySchemaResult,
): void {
  const oldByCanonical = new Map<string, number>();

  for (const job of jobs) {
    const canonicalId = split.remappedIds.get(job.id);
    if (!canonicalId) {
      throw new Error(`missing remap for job ${job.id}`);
    }
    oldByCanonical.set(canonicalId, (oldByCanonical.get(canonicalId) ?? 0) + legacyAttemptCount(job));
  }

  const newByCanonical = new Map<string, number>();
  for (const attempt of split.attempts) {
    newByCanonical.set(
      attempt.deliveryJobId,
      (newByCanonical.get(attempt.deliveryJobId) ?? 0) + 1,
    );
  }

  for (const job of split.deliveryJobs) {
    const oldCount = oldByCanonical.get(job.id) ?? 0;
    const newCount = newByCanonical.get(job.id) ?? 0;
    if (oldCount !== newCount) {
      throw new Error(`per-job attempt-count parity failed for ${job.id}: old=${oldCount} new=${newCount}`);
    }
  }

  const oldTotal = jobs.reduce((sum, job) => sum + legacyAttemptCount(job), 0);
  if (oldTotal !== split.attempts.length) {
    throw new Error(
      `aggregate attempt-count parity failed: old=${oldTotal} new=${split.attempts.length}`,
    );
  }
}

export function isTerminalAttemptStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
