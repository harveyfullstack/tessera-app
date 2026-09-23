import { randomUUID } from "crypto";
import { JobAlreadyRunningError, JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type { CreateJobInput, JobRecord, JobType } from "../../domain/job";
import type {
  AppendExecutionInput, DeliveryAttempt, DeliveryIntent, DeliveryParity, DeliveryRollout,
} from "../../domain/delivery-attempt";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly intents = new Map<string, DeliveryIntent>();
  private readonly keys = new Map<string, string>();
  private readonly snapshots = new Map<string, JobRecord>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();
  private readonly legacyEvents = new Map<string, DeliveryAttempt[]>();
  private readonly rollouts = new Map<string, DeliveryRollout>();
  private readonly duplicates = new Map<string, Set<string>>();

  constructor(legacyJobs: JobRecord[] = [], private readonly clock: () => Date = () => new Date()) {
    for (const row of legacyJobs) {
      const job = structuredClone(row);
      this.jobs.set(job.id, job);
      this.snapshots.set(job.id, structuredClone(job));
      const key = this.key(job);
      if (this.keys.has(key)) {
        const duplicates = this.duplicates.get(job.accountId) ?? new Set<string>();
        duplicates.add(key);
        this.duplicates.set(job.accountId, duplicates);
      } else {
        this.keys.set(key, job.id);
      }
    }
    for (const job of this.jobs.values()) {
      if (!this.duplicates.get(job.accountId)?.has(this.key(job))) this.storeIntent(job);
    }
  }

  private key(input: Pick<CreateJobInput, "accountId" | "briefId" | "type">): string {
    return JSON.stringify([input.accountId, input.briefId, input.type]);
  }

  private storeIntent(job: JobRecord): void {
    const { id, accountId, briefId, taskId, parentJobId, type, metadata, createdAt } = job;
    this.intents.set(id, structuredClone({ id, accountId, briefId, taskId, parentJobId, type, metadata, createdAt }));
  }

  private project(job: JobRecord): JobRecord {
    return structuredClone({ ...job, latestAttempt: this.attempts.get(job.id)?.at(-1) });
  }

  async findByBriefAndType(briefId: string, type: JobType, accountId?: string): Promise<JobRecord[]> {
    return (await this.listByBrief(briefId, accountId)).filter((job) => job.type === type);
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    const job = this.jobs.get(jobId);
    return job ? this.project(job) : null;
  }

  async ensureIntent(input: CreateJobInput): Promise<JobRecord> {
    const key = this.key(input);
    if (this.duplicates.get(input.accountId)?.has(key)) throw new Error("Unresolved duplicate delivery intent");
    const existingId = this.keys.get(key);
    if (existingId) return this.project(this.jobs.get(existingId)!);
    const now = this.clock();
    const job: JobRecord = { ...structuredClone(input), id: randomUUID(), status: "queued",
      retryCount: 0, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    this.keys.set(key, job.id);
    this.storeIntent(job);
    return this.project(job);
  }

  async listByBrief(briefId: string, accountId?: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.briefId === briefId &&
      (accountId === undefined || job.accountId === accountId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((job) => this.project(job));
  }

  async getIntent(jobId: string): Promise<DeliveryIntent | null> {
    return structuredClone(this.intents.get(jobId) ?? null);
  }

  async getLegacySnapshot(jobId: string): Promise<JobRecord | null> {
    return structuredClone(this.snapshots.get(jobId) ?? null);
  }

  async listAttempts(jobId: string): Promise<DeliveryAttempt[]> {
    if (!this.jobs.has(jobId)) throw new JobNotFoundError(jobId);
    return structuredClone(this.attempts.get(jobId) ?? []);
  }

  async appendExecution(jobId: string, input: AppendExecutionInput,
    source: (accountId: string) => "legacy" | "attempts"): Promise<JobRecord> {
    // No await in this critical section: all reads and writes commit in one JS turn.
    const job = this.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (!this.intents.has(jobId)) throw new Error("Unresolved duplicate delivery intent");
    const executionSource = source(job.accountId);
    const history = this.attempts.get(jobId) ?? [];
    if (input.operation === "execution" && input.expectedSequence !== undefined &&
      (history.at(-1)?.attemptNumber !== input.expectedSequence || history.at(-1)?.status !== "failed")) {
      return { ...this.project(job), executionSource };
    }
    const now = this.clock();
    const updated = this.nextExecution(job, input, now);
    const attempt: DeliveryAttempt = {
      id: randomUUID(), jobId, accountId: job.accountId, attemptNumber: history.length + 1,
      operation: input.operation, status: updated.status, workerId: updated.workerId,
      retryCount: updated.retryCount, errorMessage: updated.errorMessage,
      details: input.operation === "execution" ? structuredClone(input.execution.details ?? {}) : {},
      startedAt: updated.startedAt, completedAt: updated.completedAt, createdAt: now,
    };
    this.jobs.set(jobId, updated);
    this.attempts.set(jobId, [...history, attempt]);
    this.legacyEvents.set(jobId, [...(this.legacyEvents.get(jobId) ?? []), structuredClone(attempt)]);
    return { ...this.project(updated), executionSource };
  }

  private nextExecution(job: JobRecord, input: AppendExecutionInput, now: Date): JobRecord {
    if (input.operation === "retry") return { ...job, retryCount: job.retryCount + 1, updatedAt: now };
    const execution = input.execution;
    if (execution.status === "running" && job.status === "running") throw new JobAlreadyRunningError(job.id);
    if (execution.status === "running" && job.status === "dlq") throw new Error(`Delivery is in the dead letter queue: ${job.id}`);
    const terminal = ["completed", "failed", "cancelled", "dlq"].includes(execution.status);
    return { ...job, status: execution.status,
      workerId: execution.workerId ?? execution.details?.workerId ?? job.workerId,
      errorMessage: execution.errorMessage, updatedAt: now,
      startedAt: execution.status === "running" ? now : job.startedAt,
      completedAt: terminal ? now : undefined };
  }

  getParity(accountId: string): DeliveryParity {
    const ids = [...this.jobs.values()].filter((job) => job.accountId === accountId).map((job) => job.id);
    const count = (rows: Map<string, DeliveryAttempt[]>) => ids.reduce((sum, id) => sum + (rows.get(id)?.length ?? 0), 0);
    const legacyEventCount = count(this.legacyEvents);
    const attemptCount = count(this.attempts);
    const unresolvedDuplicateKeys = this.duplicates.get(accountId)?.size ?? 0;
    const jobs = ids.map((jobId) => ({ jobId, legacyEventCount: this.legacyEvents.get(jobId)?.length ?? 0,
      attemptCount: this.attempts.get(jobId)?.length ?? 0,
      matches: JSON.stringify(this.legacyEvents.get(jobId) ?? []) === JSON.stringify(this.attempts.get(jobId) ?? []),
    }));
    const sameEvents = jobs.every((job) => job.matches);
    return { accountId, legacyEventCount, attemptCount, unresolvedDuplicateKeys, jobs,
      matches: unresolvedDuplicateKeys === 0 && legacyEventCount === attemptCount && sameEvents };
  }

  getRollout(accountId: string): DeliveryRollout {
    return structuredClone(this.rollouts.get(accountId) ?? { enabled: false });
  }

  setRollout(accountId: string, rollout: DeliveryRollout): void {
    this.rollouts.set(accountId, structuredClone(rollout));
  }
}
