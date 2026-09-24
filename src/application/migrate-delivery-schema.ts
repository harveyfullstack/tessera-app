import { randomUUID } from "crypto";
import { DeliverySchemaMigrationError } from "../domain/errors";
import type {
  AttemptCountAggregate,
  AttemptCountParity,
  AttemptParityProof,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryJobSource,
  DeliveryMigrationResult,
} from "../domain/delivery-schema";
import { legacyJobAttemptCount } from "../domain/legacy-attempt-count";
import type { JobMetadata, JobRecord } from "../domain/job";

interface AttemptSlice {
  job: JobRecord;
  deliveryJobId: string;
  attemptCount: number;
}

interface AttemptTally {
  legacy: number;
  fresh: number;
}

interface LegacyIdentity {
  id: string;
  createdAt: Date;
}

export function migrateDeliverySchema(legacyJobs: readonly JobRecord[]): DeliveryMigrationResult {
  assertLegacyRows(legacyJobs);
  const canonicalByLegacyId = canonicalIds(legacyJobs);
  assertUniformIntent(legacyJobs, canonicalByLegacyId);

  const sources = buildSources(legacyJobs, canonicalByLegacyId);
  const deliveryJobs = buildDeliveryJobs(legacyJobs, canonicalByLegacyId);
  const attempts = buildAttempts(legacyJobs, canonicalByLegacyId);
  assertLosslessSplit(legacyJobs, sources, deliveryJobs, attempts);

  const proof = proveAttemptCountParity(legacyJobs, sources, attempts);
  if (!proof.ok) {
    throw new DeliverySchemaMigrationError(proof.reason ?? "attempt-count parity failed");
  }

  return {
    deliveryJobs,
    attempts,
    sources,
    parityByJob: proof.byJob,
    aggregate: proof.aggregate,
  };
}

export function proveAttemptCountParity(
  legacyJobs: readonly JobRecord[],
  sources: readonly DeliveryJobSource[],
  attempts: readonly DeliveryAttempt[],
): AttemptParityProof {
  const tallied = tallyAttemptCounts(legacyJobs, sources, attempts);
  if (!tallied.ok) {
    return failedProof(tallied.counts, tallied.reason);
  }
  return finishParityProof(legacyJobs, tallied.counts);
}

function assertLegacyRows(jobs: readonly JobRecord[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (seen.has(job.id)) {
      throw new DeliverySchemaMigrationError(`duplicate legacy job id ${job.id}`);
    }
    seen.add(job.id);
    if (Number.isNaN(job.createdAt.getTime())) {
      throw new DeliverySchemaMigrationError(`legacy job ${job.id} has an invalid createdAt`);
    }
    legacyJobAttemptCount(job);
  }
}

function canonicalIds(jobs: readonly JobRecord[]): Map<string, string> {
  const canonicalByLegacyId = new Map<string, string>();
  for (const group of groupByIntent(jobs).values()) {
    const canonical = earliestJob(group);
    for (const job of group) {
      canonicalByLegacyId.set(job.id, canonical.id);
    }
  }
  return canonicalByLegacyId;
}

function groupByIntent(jobs: readonly JobRecord[]): Map<string, JobRecord[]> {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const key = `${job.accountId}\0${job.briefId}\0${job.type}`;
    const group = groups.get(key);
    if (group) {
      group.push(job);
    } else {
      groups.set(key, [job]);
    }
  }
  return groups;
}

function earliestJob(group: readonly JobRecord[]): JobRecord {
  const sorted = [...group].sort(compareLegacyIdentity);
  const canonical = sorted[0];
  if (!canonical) {
    throw new DeliverySchemaMigrationError("empty intent group");
  }
  return canonical;
}

function tallyAttemptCounts(
  legacyJobs: readonly JobRecord[],
  sources: readonly DeliveryJobSource[],
  attempts: readonly DeliveryAttempt[],
): { ok: true; counts: Map<string, AttemptTally> } | { ok: false; counts: Map<string, AttemptTally>; reason: string } {
  const counts = new Map<string, AttemptTally>();
  for (const source of sources) {
    if (!counts.has(source.deliveryJobId)) {
      counts.set(source.deliveryJobId, { legacy: 0, fresh: 0 });
    }
  }

  const deliveryJobByLegacyId = new Map(sources.map((source) => [source.legacyJobId, source.deliveryJobId]));
  for (const job of legacyJobs) {
    const deliveryJobId = deliveryJobByLegacyId.get(job.id);
    const bucket = deliveryJobId === undefined ? undefined : counts.get(deliveryJobId);
    if (deliveryJobId === undefined || bucket === undefined) {
      return { ok: false, counts, reason: `legacy job ${job.id} was not mapped onto a delivery job` };
    }
    bucket.legacy += legacyJobAttemptCount(job);
  }

  for (const attempt of attempts) {
    const bucket = counts.get(attempt.deliveryJobId);
    if (bucket === undefined) {
      return { ok: false, counts, reason: `attempt refers to unknown delivery job ${attempt.deliveryJobId}` };
    }
    bucket.fresh += 1;
  }

  return { ok: true, counts };
}

function finishParityProof(legacyJobs: readonly JobRecord[], counts: ReadonlyMap<string, AttemptTally>): AttemptParityProof {
  const byJob = parityRows(counts);
  const aggregate = sumParity(byJob);
  const mismatch = byJob.find((row) => row.legacyAttemptCount !== row.deliveryAttemptCount);
  if (mismatch) {
    const legacy = mismatch.legacyAttemptCount;
    const fresh = mismatch.deliveryAttemptCount;
    return {
      ok: false,
      reason: `attempt-count parity failed for delivery job ${mismatch.deliveryJobId}: legacy ${legacy} <> attempts ${fresh}`,
      byJob,
      aggregate,
    };
  }

  const rawLegacy = legacyJobs.reduce((sum, job) => sum + legacyJobAttemptCount(job), 0);
  if (rawLegacy !== aggregate.legacyAttemptCount || aggregate.legacyAttemptCount !== aggregate.deliveryAttemptCount) {
    return {
      ok: false,
      reason: `aggregate attempt-count parity failed: legacy ${rawLegacy} <> attempts ${aggregate.deliveryAttemptCount}`,
      byJob,
      aggregate,
    };
  }

  return { ok: true, byJob, aggregate };
}

function compareLegacyIdentity(a: LegacyIdentity, b: LegacyIdentity): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  const left = a.id.toLowerCase();
  const right = b.id.toLowerCase();
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertUniformIntent(jobs: readonly JobRecord[], canonicalByLegacyId: ReadonlyMap<string, string>): void {
  for (const group of groupByIntent(jobs).values()) {
    const canonical = earliestJob(group);
    const canonicalParent = canonicalParentId(canonical, canonicalByLegacyId);
    for (const job of group) {
      const sameParent = canonicalParentId(job, canonicalByLegacyId) === canonicalParent;
      const sameTask = job.taskId === canonical.taskId;
      if (!sameParent || !sameTask || !sameMetadata(job.metadata, canonical.metadata)) {
        throw new DeliverySchemaMigrationError(
          `duplicate intent rows for ${job.accountId}/${job.briefId}/${job.type} disagree; refusing migration`,
        );
      }
    }
  }
}

function canonicalParentId(job: JobRecord, canonicalByLegacyId: ReadonlyMap<string, string>): string | undefined {
  if (job.parentJobId === undefined) {
    return undefined;
  }
  const mapped = canonicalByLegacyId.get(job.parentJobId);
  if (mapped === undefined) {
    throw new DeliverySchemaMigrationError(`orphan parent_job_id ${job.parentJobId} on legacy job ${job.id}`);
  }
  return mapped;
}

function sameMetadata(left: JobMetadata, right: JobMetadata): boolean {
  return (
    left.customerId === right.customerId &&
    left.subscriptionId === right.subscriptionId &&
    left.endpointUrl === right.endpointUrl &&
    left.eventType === right.eventType &&
    left.payloadHash === right.payloadHash
  );
}

function buildSources(jobs: readonly JobRecord[], canonicalByLegacyId: ReadonlyMap<string, string>): DeliveryJobSource[] {
  return jobs
    .map((job) => {
      const deliveryJobId = requiredCanonical(job.id, canonicalByLegacyId);
      return {
        legacyJobId: job.id,
        deliveryJobId,
        isCanonical: deliveryJobId === job.id,
      };
    })
    .sort((a, b) => (a.legacyJobId < b.legacyJobId ? -1 : a.legacyJobId > b.legacyJobId ? 1 : 0));
}

function buildDeliveryJobs(jobs: readonly JobRecord[], canonicalByLegacyId: ReadonlyMap<string, string>): DeliveryJob[] {
  const deliveryJobs: DeliveryJob[] = [];
  for (const job of jobs) {
    if (canonicalByLegacyId.get(job.id) !== job.id) {
      continue;
    }
    const parentJobId = canonicalParentId(job, canonicalByLegacyId);
    deliveryJobs.push({
      id: job.id,
      accountId: job.accountId,
      briefId: job.briefId,
      ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
      ...(parentJobId !== undefined ? { parentJobId } : {}),
      type: job.type,
      metadata: { ...job.metadata },
      createdAt: new Date(job.createdAt.getTime()),
    });
  }
  return deliveryJobs.sort(compareLegacyIdentity);
}

function buildAttempts(jobs: readonly JobRecord[], canonicalByLegacyId: ReadonlyMap<string, string>): DeliveryAttempt[] {
  const slices: AttemptSlice[] = jobs
    .map((job) => ({
      job,
      deliveryJobId: requiredCanonical(job.id, canonicalByLegacyId),
      attemptCount: legacyJobAttemptCount(job),
    }))
    .sort((left, right) => {
      if (left.deliveryJobId !== right.deliveryJobId) {
        return left.deliveryJobId < right.deliveryJobId ? -1 : 1;
      }
      return compareLegacyIdentity(left.job, right.job);
    });

  const nextNumber = new Map<string, number>();
  const attempts: DeliveryAttempt[] = [];
  for (const slice of slices) {
    for (let localNumber = 1; localNumber <= slice.attemptCount; localNumber += 1) {
      const attemptNumber = (nextNumber.get(slice.deliveryJobId) ?? 0) + 1;
      nextNumber.set(slice.deliveryJobId, attemptNumber);
      attempts.push(toAttempt(slice, attemptNumber, localNumber === slice.attemptCount));
    }
  }
  return attempts;
}

function toAttempt(slice: AttemptSlice, attemptNumber: number, isLatest: boolean): DeliveryAttempt {
  if (!isLatest) {
    return {
      id: randomUUID(),
      deliveryJobId: slice.deliveryJobId,
      attemptNumber,
      status: "failed",
    };
  }

  return {
    id: randomUUID(),
    deliveryJobId: slice.deliveryJobId,
    attemptNumber,
    status: slice.job.status,
    ...(slice.job.workerId !== undefined ? { workerId: slice.job.workerId } : {}),
    ...(slice.job.errorMessage !== undefined ? { errorBody: slice.job.errorMessage } : {}),
  };
}

function assertLosslessSplit(
  jobs: readonly JobRecord[],
  sources: readonly DeliveryJobSource[],
  deliveryJobs: readonly DeliveryJob[],
  attempts: readonly DeliveryAttempt[],
): void {
  if (sources.length !== jobs.length) {
    throw new DeliverySchemaMigrationError(`source map has ${sources.length} rows for ${jobs.length} legacy jobs`);
  }

  const legacyIds = new Set<string>();
  const canonicalIds = new Set<string>();
  for (const source of sources) {
    if (legacyIds.has(source.legacyJobId)) {
      throw new DeliverySchemaMigrationError(`duplicate source for legacy job ${source.legacyJobId}`);
    }
    legacyIds.add(source.legacyJobId);
    if (source.isCanonical) {
      canonicalIds.add(source.deliveryJobId);
    }
  }

  for (const job of jobs) {
    if (!legacyIds.has(job.id)) {
      throw new DeliverySchemaMigrationError(`source map lost legacy job ${job.id}`);
    }
  }
  if (canonicalIds.size !== deliveryJobs.length) {
    throw new DeliverySchemaMigrationError("delivery_jobs count does not match canonical intent groups");
  }

  assertUniqueIntent(deliveryJobs);
  assertUniqueAttemptNumbers(attempts);
}

function assertUniqueIntent(jobs: readonly DeliveryJob[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    const key = `${job.accountId}\0${job.briefId}\0${job.type}`;
    if (seen.has(key)) {
      throw new DeliverySchemaMigrationError(`duplicate delivery intent ${job.accountId}/${job.briefId}/${job.type}`);
    }
    seen.add(key);
  }
}

function assertUniqueAttemptNumbers(attempts: readonly DeliveryAttempt[]): void {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (!Number.isInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
      throw new DeliverySchemaMigrationError(`attempt number must be a positive integer`);
    }
    const key = `${attempt.deliveryJobId}\0${attempt.attemptNumber}`;
    if (seen.has(key)) {
      throw new DeliverySchemaMigrationError(`duplicate attempt ${attempt.deliveryJobId}#${attempt.attemptNumber}`);
    }
    seen.add(key);
  }
}

function requiredCanonical(legacyId: string, canonicalByLegacyId: ReadonlyMap<string, string>): string {
  const deliveryJobId = canonicalByLegacyId.get(legacyId);
  if (deliveryJobId === undefined) {
    throw new DeliverySchemaMigrationError(`legacy job ${legacyId} has no canonical delivery job`);
  }
  return deliveryJobId;
}

function parityRows(counts: ReadonlyMap<string, AttemptTally>): AttemptCountParity[] {
  return [...counts.entries()]
    .map(([deliveryJobId, count]) => ({
      deliveryJobId,
      legacyAttemptCount: count.legacy,
      deliveryAttemptCount: count.fresh,
    }))
    .sort((left, right) => (left.deliveryJobId < right.deliveryJobId ? -1 : left.deliveryJobId > right.deliveryJobId ? 1 : 0));
}

function sumParity(rows: readonly AttemptCountParity[]): AttemptCountAggregate {
  return rows.reduce(
    (sum, row) => ({
      legacyAttemptCount: sum.legacyAttemptCount + row.legacyAttemptCount,
      deliveryAttemptCount: sum.deliveryAttemptCount + row.deliveryAttemptCount,
    }),
    { legacyAttemptCount: 0, deliveryAttemptCount: 0 },
  );
}

function failedProof(counts: ReadonlyMap<string, AttemptTally>, reason: string): AttemptParityProof {
  const byJob = parityRows(counts);
  return { ok: false, reason, byJob, aggregate: sumParity(byJob) };
}
