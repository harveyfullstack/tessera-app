import { randomUUID } from "crypto";
import { countTerminalDeliveryAttempts, legacyBackfillAttemptCount, legacyTerminalAttemptCount } from "./delivery-execution-metrics";
import type { DeliveryAttemptRecord } from "../domain/delivery-attempt";
import type { JobRecord, JobStatus } from "../domain/job";

export interface ArchivedDuplicateIntent extends JobRecord {
  canonicalDeliveryJobId: string;
}

export interface AttemptParityResult {
  deliveryJobId: string;
  legacyAttemptCount: number;
  attemptRowCount: number;
  matches: boolean;
}

export interface MigratedDeliverySchema {
  deliveryJobs: JobRecord[];
  archivedDuplicates: ArchivedDuplicateIntent[];
  attempts: DeliveryAttemptRecord[];
}

export function intentKey(job: Pick<JobRecord, "accountId" | "briefId" | "type">): string {
  return `${job.accountId}:${job.briefId}:${job.type}`;
}

export function backfillAttemptsFromLegacyJob(job: JobRecord): DeliveryAttemptRecord[] {
  const count = legacyBackfillAttemptCount(job);
  const attempts: DeliveryAttemptRecord[] = [];

  for (let attemptNumber = 1; attemptNumber <= count; attemptNumber += 1) {
    const isLatest = attemptNumber === count;
    const status: JobStatus = isLatest ? job.status : "failed";
    attempts.push({
      id: randomUUID(),
      deliveryJobId: job.id,
      attemptNumber,
      workerId: isLatest ? job.workerId : undefined,
      status,
      errorBody: isLatest ? job.errorMessage : "legacy failed execution",
      startedAt: job.startedAt ?? job.updatedAt,
      completedAt: isLatest ? job.completedAt : undefined,
      createdAt: job.updatedAt,
    });
  }

  return attempts;
}

export function migrateDeliveryJobs(jobs: JobRecord[]): MigratedDeliverySchema {
  const ranked = [...jobs].sort((a, b) => {
    const updated = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (updated !== 0) {
      return updated;
    }
    const created = a.createdAt.getTime() - b.createdAt.getTime();
    if (created !== 0) {
      return created;
    }
    return a.id.localeCompare(b.id);
  });

  const canonicalByKey = new Map<string, JobRecord>();
  const archivedDuplicates: ArchivedDuplicateIntent[] = [];

  for (const job of ranked) {
    const key = intentKey(job);
    const canonical = canonicalByKey.get(key);
    if (!canonical) {
      canonicalByKey.set(key, job);
      continue;
    }
    archivedDuplicates.push({ ...job, canonicalDeliveryJobId: canonical.id });
  }

  const deliveryJobs = [...canonicalByKey.values()];
  const attempts = deliveryJobs.flatMap(backfillAttemptsFromLegacyJob);

  return { deliveryJobs, archivedDuplicates, attempts };
}

export function verifyMigratedAttemptCountParity(schema: MigratedDeliverySchema): {
  results: AttemptParityResult[];
  aggregateLegacy: number;
  aggregateAttempts: number;
  allMatch: boolean;
} {
  const attemptsByJob = new Map<string, DeliveryAttemptRecord[]>();
  for (const attempt of schema.attempts) {
    const rows = attemptsByJob.get(attempt.deliveryJobId) ?? [];
    rows.push(attempt);
    attemptsByJob.set(attempt.deliveryJobId, rows);
  }

  const results = schema.deliveryJobs.map((job) => {
    const rows = attemptsByJob.get(job.id) ?? [];
    const legacyAttemptCount = legacyBackfillAttemptCount(job);
    const attemptRowCount = rows.length;
    return {
      deliveryJobId: job.id,
      legacyAttemptCount,
      attemptRowCount,
      matches: attemptRowCount === legacyAttemptCount,
    };
  });

  const aggregateLegacy = results.reduce((sum, result) => sum + result.legacyAttemptCount, 0);
  const aggregateAttempts = schema.attempts.length;

  return {
    results,
    aggregateLegacy,
    aggregateAttempts,
    allMatch: results.every((result) => result.matches) && aggregateLegacy === aggregateAttempts,
  };
}

export function verifyTerminalAttemptCountParity(
  job: JobRecord,
  attempts: DeliveryAttemptRecord[],
): boolean {
  return countTerminalDeliveryAttempts(attempts) === legacyTerminalAttemptCount(job);
}
