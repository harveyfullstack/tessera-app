import { randomUUID } from "crypto";
import { DeliveryExhaustedError, JobAlreadyRunningError, JobNotFoundError } from "../../domain/errors";
import type {
  JobRepository,
} from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeadLetterEntry,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryRollout,
  JobRecord,
  UpdateJobExecutionInput,
} from "../../domain/job";

const rollbackWindowMs = 14 * 24 * 60 * 60 * 1000;
const key = (job: CreateJobInput) => JSON.stringify([job.accountId, job.briefId, job.type]);

export class InMemoryJobRepository implements JobRepository {
  private readonly retryBudgets = new Map<string, number>();
  private readonly deadLetters = new Map<string, DeadLetterEntry>();
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
    if (input.status === "running" && job.type === "dispatch_webhook" && this.exhausted(job)) {
      throw new DeliveryExhaustedError(jobId);
    }
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
    if (input.status === "queued" || input.status === "completed") this.deadLetters.delete(jobId);
    return structuredClone(updated);
  }

  private failures(jobId: string): DeliveryAttempt[] {
    const history = this.legacyAttempts.get(jobId) ?? [];
    let failures: DeliveryAttempt[] = [];
    for (const attempt of history) {
      if (attempt.status === "queued" || attempt.status === "completed") failures = [];
      else if (attempt.status === "failed") failures.push(attempt);
    }
    return failures;
  }

  private exhausted(job: JobRecord): boolean {
    return this.failures(job.id).length >= (this.retryBudgets.get(job.accountId) ?? 8);
  }

  async setRetryBudget(accountId: string, budget: number): Promise<void> {
    if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Retry budget must be a positive integer");
    this.retryBudgets.set(accountId, budget);
  }

  async drainDeadLetters(accountId: string, briefId: string): Promise<DeadLetterEntry[]> {
    for (const job of this.jobs.values()) {
      if (job.accountId !== accountId || job.briefId !== briefId || job.type !== "dispatch_webhook") continue;
      if (job.status !== "failed" || !this.exhausted(job)) {
        this.deadLetters.delete(job.id);
        continue;
      }
      const failures = this.failures(job.id);
      this.deadLetters.set(job.id, {
        deliveryJobId: job.id, accountId, briefId, endpointUrl: job.metadata.endpointUrl,
        failedAttemptCount: failures.length,
        lastAttemptBodies: failures.slice(-3).reverse().map((attempt) => attempt.errorBody ?? null),
        enqueuedAt: this.deadLetters.get(job.id)?.enqueuedAt ?? new Date(),
      });
    }
    return this.listDeadLetters(accountId, briefId);
  }

  async listDeadLetters(accountId: string, briefId: string): Promise<DeadLetterEntry[]> {
    return structuredClone([...this.deadLetters.values()].filter((entry) => entry.accountId === accountId && entry.briefId === briefId));
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
