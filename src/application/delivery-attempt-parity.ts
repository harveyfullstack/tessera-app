import { randomUUID } from "crypto";
import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

const OVERWRITTEN_ERROR = "overwritten by retry before delivery_attempts cutover";

export function intentKey(job: Pick<JobRecord, "accountId" | "briefId" | "type">): string {
  return `${job.accountId}\0${job.briefId}\0${job.type}`;
}

export function isNeverStarted(job: JobRecord): boolean {
  return job.status === "queued" && job.startedAt === undefined && job.retryCount === 0;
}

export function legacyAttemptCount(job: JobRecord): number {
  if (isNeverStarted(job)) {
    return 0;
  }

  return Math.max(job.retryCount, 1);
}

export function selectCanonicalJob(jobs: JobRecord[]): JobRecord {
  const [canonical] = [...jobs].sort((a, b) => {
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) {
      return byCreated;
    }

    return a.id.localeCompare(b.id);
  });

  if (!canonical) {
    throw new Error("Cannot select a canonical delivery job from an empty group");
  }

  return canonical;
}

export function groupByIntent(jobs: JobRecord[]): Map<string, JobRecord[]> {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const key = intentKey(job);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }

  return groups;
}

export function expandJobAttempts(job: JobRecord, deliveryJobId: string, startAt: number): DeliveryAttempt[] {
  const count = legacyAttemptCount(job);
  const attempts: DeliveryAttempt[] = [];

  for (let offset = 1; offset <= count; offset += 1) {
    const isLatestOnRow = offset === count;
    attempts.push({
      id: randomUUID(),
      deliveryJobId,
      attemptNumber: startAt + offset,
      workerId: isLatestOnRow ? job.workerId : undefined,
      status: isLatestOnRow ? job.status : "failed",
      errorBody: isLatestOnRow ? job.errorMessage : OVERWRITTEN_ERROR,
      startedAt: isLatestOnRow ? job.startedAt : undefined,
      completedAt: isLatestOnRow ? job.completedAt : undefined,
      createdAt: job.createdAt,
    });
  }

  return attempts;
}

export interface DeliveryIntentMigration {
  deliveryJobs: JobRecord[];
  attempts: DeliveryAttempt[];
}

export function migrateDeliveryIntent(jobs: JobRecord[]): DeliveryIntentMigration {
  const deliveryJobs: JobRecord[] = [];
  const attempts: DeliveryAttempt[] = [];

  for (const group of groupByIntent(jobs).values()) {
    const canonical = selectCanonicalJob(group);
    const ordered = [...group].sort((a, b) => {
      const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreated !== 0) {
        return byCreated;
      }

      return a.id.localeCompare(b.id);
    });

    let nextNumber = 0;
    for (const source of ordered) {
      const expanded = expandJobAttempts(source, canonical.id, nextNumber);
      nextNumber += expanded.length;
      attempts.push(...expanded);
    }

    deliveryJobs.push(canonical);
  }

  return { deliveryJobs, attempts };
}

export class AttemptCountParityError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function assertAttemptCountParity(jobs: JobRecord[], attempts: DeliveryAttempt[]): void {
  const migrated = migrateDeliveryIntent(jobs);
  const expectedByJob = new Map<string, number>();

  for (const job of jobs) {
    const canonicalId = selectCanonicalJob(
      groupByIntent(jobs).get(intentKey(job)) ?? [job],
    ).id;
    expectedByJob.set(canonicalId, (expectedByJob.get(canonicalId) ?? 0) + legacyAttemptCount(job));
  }

  const actualByJob = new Map<string, number>();
  for (const attempt of attempts) {
    actualByJob.set(attempt.deliveryJobId, (actualByJob.get(attempt.deliveryJobId) ?? 0) + 1);
  }

  for (const [jobId, expected] of expectedByJob) {
    const actual = actualByJob.get(jobId) ?? 0;
    if (expected !== actual) {
      throw new AttemptCountParityError(
        `per-job attempt-count parity failed for ${jobId}: old=${expected} new=${actual}`,
      );
    }
  }

  const oldTotal = [...expectedByJob.values()].reduce((sum, count) => sum + count, 0);
  if (oldTotal !== attempts.length) {
    throw new AttemptCountParityError(
      `aggregate attempt-count parity failed: old=${oldTotal} new=${attempts.length}`,
    );
  }

  if (migrated.deliveryJobs.length !== new Set(jobs.map(intentKey)).size) {
    throw new AttemptCountParityError("canonical delivery_jobs count does not match unique intent keys");
  }
}
