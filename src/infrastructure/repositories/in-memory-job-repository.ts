import { deliveryFailureCount } from "../../domain/job";
import { randomUUID } from "crypto";
import { JobNotFoundError } from "../../domain/errors";
import type { JobRepository } from "../../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryAttempt,
  DeliveryExecutionCommand,
  DeliveryJob,
  JobRecord,
  JobType,
} from "../../domain/job";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly intents = new Map<string, DeliveryJob>();
  private readonly intentKeys = new Map<string, string>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  async findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]> {
    return structuredClone([...this.jobs.values()]
      .filter((job) => job.briefId === briefId && job.type === type)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()));
  }

  async findById(jobId: string): Promise<JobRecord | null> {
    return structuredClone(this.jobs.get(jobId) ?? null);
  }

  async findDeliveryJob(deliveryJobId: string): Promise<DeliveryJob | null> {
    return structuredClone(this.intents.get(deliveryJobId) ?? null);
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return structuredClone(this.attempts.get(deliveryJobId) ?? []);
  }

  async ensure(input: CreateJobInput): Promise<JobRecord> {
    // No await between lookup and insertion: one atomic operation in this runtime.
    const intentId = this.intentKeys.get(this.intentKey(input));
    const existing = [...this.jobs.values()].find((job) => job.deliveryJobId === intentId);
    return existing ? structuredClone(existing) : this.create(input);
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const now = new Date();
    const id = randomUUID();
    const key = this.intentKey(input);
    const deliveryJobId = this.intentKeys.get(key) ?? id;
    if (!this.intents.has(deliveryJobId)) {
      this.intents.set(deliveryJobId, structuredClone({ ...input, id: deliveryJobId, createdAt: now }));
      this.intentKeys.set(key, deliveryJobId);
    }
    // Legacy duplicates remain allowed, but all point to one immutable intent.
    const job: JobRecord = {
      ...structuredClone(input), id, deliveryJobId,
      status: "queued", retryCount: 0, createdAt: now, updatedAt: now,
    };
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  async execute(
    jobId: string,
    command: DeliveryExecutionCommand,
    appendAttempt: boolean,
  ): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    const history = this.attempts.get(job.deliveryJobId) ?? [];
    // A terminal DLQ intent cannot be restarted through a stale legacy duplicate.
    if (appendAttempt && history.at(-1)?.status === "dlq") return structuredClone({ ...job, status: "dlq" });
    const legacyRetryCounts = [...this.jobs.values()]
      .filter((row) => row.deliveryJobId === job.deliveryJobId).map((row) => row.retryCount);
    if (command.kind === "drain_dlq") {
      const currentStatus = appendAttempt ? history.at(-1)?.status ?? job.status : job.status;
      if (!appendAttempt || job.type !== "dispatch_webhook"
        || !["failed", "queued"].includes(currentStatus)
        || deliveryFailureCount(history, legacyRetryCounts) < command.retryBudget) {
        return structuredClone({ ...job, status: currentStatus });
      }
      command = { kind: "update", input: { status: "dlq" } };
    }
    const now = new Date();
    const input = command.kind === "update" ? command.input : undefined;
    const status = input?.status ?? (appendAttempt ? "queued" : job.status);
    const updated: JobRecord = {
      ...job, status, updatedAt: now,
      retryCount: job.retryCount + (command.kind === "retry" ? 1 : 0),
      workerId: input?.workerId ?? input?.details?.workerId ?? job.workerId,
      errorMessage: command.kind === "retry" ? job.errorMessage : input?.errorMessage,
      startedAt: input?.status === "running" ? now : job.startedAt,
      completedAt: input && ["completed", "failed", "cancelled", "dlq"].includes(input.status)
        ? now : job.completedAt,
    };
    const attempt: DeliveryAttempt = {
      id: randomUUID(), deliveryJobId: job.deliveryJobId,
      attemptNumber: history.length + 1, status, startedAt: now,
      legacyRetryCount: history[0]?.legacyRetryCount ?? Math.max(0, ...legacyRetryCounts),
      workerId: updated.workerId,
      responseStatus: input?.details?.responseStatus,
      responseLatencyMs: input?.details?.responseLatencyMs,
      errorBody: input?.details?.errorBody ?? input?.errorMessage,
    };
    if (appendAttempt) this.validateAttempt(attempt);
    // No awaits: allocation, append, and rollback projection commit together.
    if (appendAttempt) this.attempts.set(job.deliveryJobId, [...history, attempt]);
    this.jobs.set(jobId, updated);
    return structuredClone(updated);
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return structuredClone([...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()));
  }

  private intentKey(input: CreateJobInput): string {
    return JSON.stringify([input.accountId, input.briefId, input.type]);
  }

  private validateAttempt(attempt: DeliveryAttempt): void {
    if (attempt.responseStatus !== undefined && (!Number.isInteger(attempt.responseStatus)
      || attempt.responseStatus < 100 || attempt.responseStatus > 599)) {
      throw new Error("Invalid delivery response status");
    }
    if (attempt.responseLatencyMs !== undefined && (!Number.isInteger(attempt.responseLatencyMs)
      || attempt.responseLatencyMs < 0)) {
      throw new Error("Invalid delivery response latency");
    }
  }
}
