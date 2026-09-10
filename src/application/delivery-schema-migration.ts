import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

export interface AttemptCountParityRow {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  type: string;
  oldCount: number;
  newCount: number;
}

export interface AttemptCountParityReport {
  perJob: AttemptCountParityRow[];
  oldAggregate: number;
  newAggregate: number;
  matched: boolean;
}

export interface DeliverySchemaMigrationResult {
  deliveryJobs: JobRecord[];
  attempts: DeliveryAttempt[];
  parity: AttemptCountParityReport;
}

export function legacyAttemptCount(job: JobRecord): number {
  if (job.startedAt === undefined && job.status === "queued") {
    return 0;
  }

  return job.retryCount + 1;
}

export function intentKey(job: Pick<JobRecord, "accountId" | "briefId" | "type">): string {
  return `${job.accountId}\0${job.briefId}\0${job.type}`;
}

export function proveAttemptCountParity(
  legacyJobs: JobRecord[],
  deliveryJobs: JobRecord[],
  attempts: DeliveryAttempt[],
): AttemptCountParityReport {
  const attemptsByJob = new Map<string, number>();
  for (const attempt of attempts) {
    attemptsByJob.set(attempt.deliveryJobId, (attemptsByJob.get(attempt.deliveryJobId) ?? 0) + 1);
  }

  const perJob: AttemptCountParityRow[] = deliveryJobs.map((job) => {
    const oldCount = legacyJobs
      .filter(
        (legacy) =>
          legacy.accountId === job.accountId &&
          legacy.briefId === job.briefId &&
          legacy.type === job.type,
      )
      .reduce((sum, legacy) => sum + legacyAttemptCount(legacy), 0);

    return {
      deliveryJobId: job.id,
      accountId: job.accountId,
      briefId: job.briefId,
      type: job.type,
      oldCount,
      newCount: attemptsByJob.get(job.id) ?? 0,
    };
  });

  const oldAggregate = legacyJobs.reduce((sum, job) => sum + legacyAttemptCount(job), 0);
  const newAggregate = attempts.length;
  const matched =
    oldAggregate === newAggregate && perJob.every((row) => row.oldCount === row.newCount);

  return { perJob, oldAggregate, newAggregate, matched };
}

export function migrateJobsToDeliverySchema(legacyJobs: JobRecord[]): DeliverySchemaMigrationResult {
  const byIntent = new Map<string, JobRecord[]>();
  for (const job of legacyJobs) {
    const key = intentKey(job);
    const group = byIntent.get(key) ?? [];
    group.push(job);
    byIntent.set(key, group);
  }

  const deliveryJobs: JobRecord[] = [];
  const attempts: DeliveryAttempt[] = [];

  for (const group of byIntent.values()) {
    const canonical = [...group].sort((a, b) => {
      const created = a.createdAt.getTime() - b.createdAt.getTime();
      return created !== 0 ? created : a.id.localeCompare(b.id);
    })[0];

    if (!canonical) {
      continue;
    }

    deliveryJobs.push({ ...canonical });

    const sources = [...group].sort((a, b) => {
      const updated = a.updatedAt.getTime() - b.updatedAt.getTime();
      return updated !== 0 ? updated : a.id.localeCompare(b.id);
    });

    let nextAttempt = 1;
    for (const source of sources) {
      const count = legacyAttemptCount(source);
      for (let offset = 1; offset <= count; offset += 1) {
        const isLatestForSource = offset === count;
        attempts.push({
          id: `${source.id}-attempt-${offset}`,
          deliveryJobId: canonical.id,
          attemptNumber: nextAttempt,
          ...(isLatestForSource && source.workerId !== undefined
            ? { workerId: source.workerId }
            : {}),
          status: isLatestForSource ? source.status : "failed",
          ...(isLatestForSource && source.errorMessage !== undefined
            ? { errorBody: source.errorMessage }
            : {}),
          ...(isLatestForSource && source.startedAt !== undefined
            ? { startedAt: source.startedAt }
            : {}),
          createdAt: source.updatedAt,
        });
        nextAttempt += 1;
      }
    }
  }

  const parity = proveAttemptCountParity(legacyJobs, deliveryJobs, attempts);
  if (!parity.matched) {
    throw new Error(
      `attempt-count parity failed: old=${parity.oldAggregate} new=${parity.newAggregate}`,
    );
  }

  return { deliveryJobs, attempts, parity };
}
