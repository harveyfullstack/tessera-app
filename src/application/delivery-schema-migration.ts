import { randomUUID } from "crypto";
import type {
  AttemptCountParity,
  DeliveryAttempt,
  DeliveryAttemptStatus,
  DeliveryJob,
  DeliverySchemaMigrationResult,
} from "../domain/delivery";
import type { JobRecord, JobStatus } from "../domain/job";

function intentKey(job: Pick<JobRecord, "accountId" | "briefId" | "type">): string {
  return `${job.accountId}\0${job.briefId}\0${job.type}`;
}

function isUntouchedQueued(job: JobRecord): boolean {
  return job.status === "queued" && job.startedAt === undefined && job.retryCount === 0;
}

/**
 * Reconstruct how many execution attempts a pre-split jobs row represents.
 * Untouched queued rows contribute 0. Otherwise retry_count records completed
 * retries and +1 accounts for the current (or last) execution snapshot.
 */
export function legacyAttemptCount(job: JobRecord): number {
  if (isUntouchedQueued(job)) {
    return 0;
  }
  return job.retryCount + 1;
}

function toDeliveryJob(job: JobRecord): DeliveryJob {
  return {
    id: job.id,
    accountId: job.accountId,
    briefId: job.briefId,
    taskId: job.taskId,
    parentJobId: job.parentJobId,
    type: job.type,
    metadata: job.metadata,
    createdAt: job.createdAt,
  };
}

function asAttemptStatus(status: JobStatus): DeliveryAttemptStatus {
  return status === "queued" ? "failed" : status;
}

function attemptsForSourceJob(job: JobRecord, deliveryJobId: string): DeliveryAttempt[] {
  const count = legacyAttemptCount(job);
  const attempts: DeliveryAttempt[] = [];

  for (let attemptNumber = 1; attemptNumber <= count; attemptNumber += 1) {
    const isLatest = attemptNumber === count;
    attempts.push({
      id: randomUUID(),
      deliveryJobId,
      attemptNumber,
      workerId: isLatest ? job.workerId : undefined,
      status: isLatest ? asAttemptStatus(job.status) : "failed",
      errorBody: isLatest ? job.errorMessage : undefined,
      startedAt: isLatest ? job.startedAt : undefined,
      completedAt: isLatest ? job.completedAt : undefined,
      createdAt: job.startedAt ?? job.createdAt,
    });
  }

  return attempts;
}

export function migrateJobsToDeliverySchema(jobs: JobRecord[]): DeliverySchemaMigrationResult {
  const groups = new Map<string, JobRecord[]>();

  for (const job of jobs) {
    const key = intentKey(job);
    const group = groups.get(key);
    if (group) {
      group.push(job);
    } else {
      groups.set(key, [job]);
    }
  }

  const deliveryJobs: DeliveryJob[] = [];
  const deliveryAttempts: DeliveryAttempt[] = [];
  const perJobParity: AttemptCountParity[] = [];

  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => {
      const created = a.createdAt.getTime() - b.createdAt.getTime();
      return created !== 0 ? created : a.id.localeCompare(b.id);
    });
    const canonical = ordered[0];
    if (!canonical) {
      continue;
    }

    deliveryJobs.push(toDeliveryJob(canonical));

    const mergedAttempts = ordered.flatMap((job) => attemptsForSourceJob(job, canonical.id));
    const renumbered = mergedAttempts.map((attempt, index) => ({
      ...attempt,
      attemptNumber: index + 1,
    }));
    deliveryAttempts.push(...renumbered);

    const oldAttemptCount = ordered.reduce((sum, job) => sum + legacyAttemptCount(job), 0);
    perJobParity.push({
      deliveryJobId: canonical.id,
      accountId: canonical.accountId,
      briefId: canonical.briefId,
      type: canonical.type,
      oldAttemptCount,
      newAttemptCount: renumbered.length,
      matches: oldAttemptCount === renumbered.length,
    });
  }

  const oldAttemptCount = perJobParity.reduce((sum, row) => sum + row.oldAttemptCount, 0);
  const newAttemptCount = deliveryAttempts.length;

  return {
    deliveryJobs,
    deliveryAttempts,
    perJobParity,
    aggregateParity: {
      oldAttemptCount,
      newAttemptCount,
      matches: oldAttemptCount === newAttemptCount,
    },
  };
}

export function assertAttemptCountParity(result: DeliverySchemaMigrationResult): void {
  const mismatched = result.perJobParity.filter((row) => !row.matches);
  if (mismatched.length > 0 || !result.aggregateParity.matches) {
    throw new Error(
      `attempt-count parity failed: aggregate old=${result.aggregateParity.oldAttemptCount} new=${result.aggregateParity.newAttemptCount} mismatchedJobs=${mismatched.length}`,
    );
  }
}
