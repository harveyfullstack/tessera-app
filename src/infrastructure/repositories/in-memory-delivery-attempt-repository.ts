import { randomUUID } from "crypto";
import { DeliveryAttemptConflictError, DeliveryJobNotFoundError } from "../../domain/errors";
import type { DeliveryAttemptRepository } from "../../domain/delivery-attempt-repository";
import type {
  DeliveryAttempt,
  DeliveryJob,
  EnsureDeliveryJobInput,
  NewDeliveryAttempt,
} from "../../domain/delivery-attempt";
import type { JobType } from "../../domain/job";

function intentKey(accountId: string, briefId: string, type: JobType): string {
  return JSON.stringify([accountId, briefId, type]);
}

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly deliveryJobsByKey = new Map<string, DeliveryJob>();
  private readonly deliveryJobIds = new Set<string>();
  // Ascending by attemptNumber.
  private readonly attempts = new Map<string, readonly DeliveryAttempt[]>();

  async ensureDeliveryJob(input: EnsureDeliveryJobInput): Promise<DeliveryJob> {
    const key = intentKey(input.accountId, input.briefId, input.type);
    const existing = this.deliveryJobsByKey.get(key);
    if (existing) {
      return existing;
    }

    const deliveryJob: DeliveryJob = {
      id: randomUUID(),
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      type: input.type,
      metadata: input.metadata,
      createdAt: new Date(),
    };

    this.deliveryJobsByKey.set(key, deliveryJob);
    this.deliveryJobIds.add(deliveryJob.id);
    return deliveryJob;
  }

  async findDeliveryJob(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<DeliveryJob | null> {
    return this.deliveryJobsByKey.get(intentKey(accountId, briefId, type)) ?? null;
  }

  async latestAttemptNumber(deliveryJobId: string): Promise<number> {
    return this.attempts.get(deliveryJobId)?.at(-1)?.attemptNumber ?? 0;
  }

  async insertAttempt(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    if (!this.deliveryJobIds.has(attempt.deliveryJobId)) {
      throw new DeliveryJobNotFoundError(attempt.deliveryJobId);
    }

    const history = this.attempts.get(attempt.deliveryJobId) ?? [];
    if (history.some((row) => row.attemptNumber === attempt.attemptNumber)) {
      throw new DeliveryAttemptConflictError(attempt.deliveryJobId, attempt.attemptNumber);
    }

    const row: DeliveryAttempt = { ...attempt, id: randomUUID() };
    this.attempts.set(
      attempt.deliveryJobId,
      [...history, row].sort((a, b) => a.attemptNumber - b.attemptNumber),
    );
    return row;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attempts.get(deliveryJobId) ?? [])].reverse();
  }
}
