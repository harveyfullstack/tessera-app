import { randomUUID } from "crypto";
import type {
  DeliveryAttemptRepository,
  DeliveryJobRepository,
} from "../../domain/delivery-repository";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
} from "../../domain/delivery-repository";
import type {
  CreateDeliveryAttemptInput,
  CreateDeliveryJobInput,
  DeliveryAttempt,
  DeliveryIntentKey,
  DeliveryJob,
} from "../../domain/delivery";
import { deliveryIntentKey } from "../../domain/delivery";

export class InMemoryDeliveryJobRepository implements DeliveryJobRepository {
  private readonly jobs = new Map<string, DeliveryJob>();
  private readonly intentIndex = new Map<string, string>();

  async findById(deliveryJobId: string): Promise<DeliveryJob | null> {
    return this.jobs.get(deliveryJobId) ?? null;
  }

  async findByIntentKey(key: DeliveryIntentKey): Promise<DeliveryJob | null> {
    const id = this.intentIndex.get(deliveryIntentKey(key));
    return id ? (this.jobs.get(id) ?? null) : null;
  }

  async create(input: CreateDeliveryJobInput): Promise<DeliveryJob> {
    const key: DeliveryIntentKey = {
      accountId: input.accountId,
      briefId: input.briefId,
      type: input.type,
    };
    const intent = deliveryIntentKey(key);
    if (this.intentIndex.has(intent)) {
      throw new DuplicateDeliveryJobError(key);
    }

    const job: DeliveryJob = {
      id: input.id ?? randomUUID(),
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      parentJobId: input.parentJobId,
      type: input.type,
      metadata: input.metadata,
      createdAt: input.createdAt ?? new Date(),
    };

    this.jobs.set(job.id, job);
    this.intentIndex.set(intent, job.id);
    return job;
  }

  async listByBrief(briefId: string): Promise<DeliveryJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.briefId === briefId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listAll(): Promise<DeliveryJob[]> {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async deleteById(deliveryJobId: string): Promise<void> {
    const job = this.jobs.get(deliveryJobId);
    if (!job) {
      return;
    }

    this.jobs.delete(deliveryJobId);
    this.intentIndex.delete(
      deliveryIntentKey({
        accountId: job.accountId,
        briefId: job.briefId,
        type: job.type,
      }),
    );
  }
}

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attempts = new Map<string, DeliveryAttempt>();

  async findById(attemptId: string): Promise<DeliveryAttempt | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.deliveryJobId === deliveryJobId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async findLatestByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt | null> {
    const attempts = await this.listByDeliveryJobId(deliveryJobId);
    return attempts[attempts.length - 1] ?? null;
  }

  async nextAttemptNumber(deliveryJobId: string): Promise<number> {
    const latest = await this.findLatestByDeliveryJobId(deliveryJobId);
    return (latest?.attemptNumber ?? 0) + 1;
  }

  async insert(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    const attemptNumber = input.attemptNumber ?? (await this.nextAttemptNumber(input.deliveryJobId));
    const existing = [...this.attempts.values()].find(
      (attempt) =>
        attempt.deliveryJobId === input.deliveryJobId && attempt.attemptNumber === attemptNumber,
    );
    if (existing) {
      throw new DuplicateDeliveryAttemptError(input.deliveryJobId, attemptNumber);
    }

    const attempt: DeliveryAttempt = {
      id: input.id ?? randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt,
      createdAt: input.createdAt ?? new Date(),
    };

    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  async listAll(): Promise<DeliveryAttempt[]> {
    return [...this.attempts.values()].sort((a, b) => {
      if (a.deliveryJobId === b.deliveryJobId) {
        return b.attemptNumber - a.attemptNumber;
      }
      return a.deliveryJobId.localeCompare(b.deliveryJobId);
    });
  }
}
