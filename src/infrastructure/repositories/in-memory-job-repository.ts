import { randomUUID } from "crypto";
import { JobAlreadyRunningError, JobNotFoundError } from "../../domain/errors";
import type {
  JobRepository,
} from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryRollout,
  JobRecord,
  UpdateJobExecutionInput,
} from "../../domain/job";

const rollbackWindowMs = 14 * 24 * 60 * 60 * 1000;
const key = (job: CreateJobInput) => JSON.stringify([job.accountId, job.briefId, job.type]);

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly intents = new Map<string, DeliveryJob>();
  private readonly intentKeys = new Map<string, string>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();
  private readonly legacyAttempts = new Map<string, DeliveryAttempt[]>();
  private readonly unresolvedAccounts = new Set<string>();
  private readonly rollouts = new Map<string, DeliveryRollout>();

  constructor(legacyRows: readonly JobRecord[] = []) {
    for (const job of legacyRows) {
      this.jobs.set(job.id, structuredClone(job));
      this.unresolvedAccounts.add(job.accountId);
    }
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return structuredClone(this.jobs.get(jobId) ?? null);
  }

  async ensureIntent(input: CreateJobInput): Promise<JobRecord> {
    const existingId = this.intentKeys.get(key(input));
    const existing = existingId ? this.jobs.get(existingId) : [...this.jobs.values()].find((job) => key(job) === key(input));
    if (existing) return structuredClone(existing);
    const now = new Date();
    const intent: DeliveryJob = { ...structuredClone(input), id: randomUUID(), createdAt: now };
    const job: JobRecord = { ...intent, status: "queued", retryCount: 0, updatedAt: now };
    this.intents.set(job.id, structuredClone(intent));
    this.intentKeys.set(key(input), job.id);
    this.jobs.set(job.id, structuredClone(job));
    return structuredClone(job);
  }

  async appendExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord> {
    // No await: allocation, guard, append and mirror share one critical section.
    const job = this.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (input.status === "running" && job.status === "running") throw new JobAlreadyRunningError(jobId);
    const now = new Date();
    const history = this.legacyAttempts.get(jobId) ?? [];
    const workerId = input.workerId ?? input.details?.workerId ?? job.workerId;
    const terminal = ["completed", "failed", "cancelled"].includes(input.status);
    const attempt: DeliveryAttempt = {
      ...structuredClone(input.details), id: randomUUID(), deliveryJobId: jobId,
      attemptNumber: (history.at(-1)?.attemptNumber ?? 0) + 1,
      status: input.status, workerId, errorMessage: input.errorMessage,
      errorBody: input.details?.errorBody ?? input.errorMessage,
      startedAt: input.status === "running" ? now : job.startedAt,
      completedAt: terminal ? now : undefined, createdAt: now,
    };
    const updated: JobRecord = {
      ...job, status: input.status, workerId, errorMessage: input.errorMessage,
      retryCount: job.retryCount + (input.incrementRetry ? 1 : 0),
      startedAt: attempt.startedAt, completedAt: attempt.completedAt, updatedAt: now,
    };
    this.legacyAttempts.set(jobId, [...history, structuredClone(attempt)]);
    if (this.intents.has(jobId)) this.attempts.set(jobId, [...(this.attempts.get(jobId) ?? []), structuredClone(attempt)]);
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return structuredClone([...this.jobs.values()].filter((job) => job.briefId === briefId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()));
  }

  async listAttempts(jobId: string): Promise<DeliveryAttempt[]> {
    return structuredClone(this.attempts.get(jobId) ?? []);
  }

  async listLegacyAttempts(jobId: string): Promise<DeliveryAttempt[]> {
    return structuredClone(this.legacyAttempts.get(jobId) ?? []);
  }

  async findIntent(jobId: string): Promise<DeliveryJob | null> {
    return structuredClone(this.intents.get(jobId) ?? null);
  }

  async getRollout(accountId: string): Promise<DeliveryRollout> {
    return structuredClone(this.rollouts.get(accountId) ?? { enabled: false });
  }

  async setRollout(accountId: string, enabled: boolean): Promise<DeliveryRollout> {
    const rows = [...this.jobs.values()].filter((job) => job.accountId === accountId);
    if (enabled && (this.unresolvedAccounts.has(accountId) || rows.some((job) =>
      !this.intents.has(job.id) || (this.attempts.get(job.id)?.length ?? 0) !== (this.legacyAttempts.get(job.id)?.length ?? 0)))) {
      throw new Error(`Delivery cutover blocked for account ${accountId}`);
    }
    const previous = this.rollouts.get(accountId);
    const enabledAt = enabled && !previous?.enabled ? new Date() : previous?.enabledAt;
    const rollout: DeliveryRollout = { enabled, enabledAt,
      rollbackUntil: enabledAt ? new Date(enabledAt.getTime() + rollbackWindowMs) : undefined };
    this.rollouts.set(accountId, rollout);
    return structuredClone(rollout);
  }
}
