import { randomUUID } from "crypto";
import { AttemptNumberConflictError } from "../../domain/errors";
import type { DeliveryAttemptRepository } from "../../domain/delivery-attempt-repository";
import type {
  DeliveryAttempt,
  DeliveryJob,
  EnsureDeliveryJobInput,
  InsertDeliveryAttemptInput,
} from "../../domain/delivery-attempt";

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly deliveryJobs = new Map<string, DeliveryJob>();
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  async ensureDeliveryJob(input: EnsureDeliveryJobInput): Promise<DeliveryJob> {
    const key = `${input.accountId}|${input.briefId}|${input.type}`;
    const existing = this.deliveryJobs.get(key);
    if (existing) {
      return existing;
    }

    const deliveryJob: DeliveryJob = {
      id: input.id,
      accountId: input.accountId,
      briefId: input.briefId,
      taskId: input.taskId,
      type: input.type,
      metadata: input.metadata,
      createdAt: new Date(),
    };
    this.deliveryJobs.set(key, deliveryJob);
    return deliveryJob;
  }

  async latestAttemptNumber(deliveryJobId: string): Promise<number> {
    const rows = this.attempts.get(deliveryJobId) ?? [];
    return rows.reduce((max, row) => Math.max(max, row.attemptNumber), 0);
  }

  async insertAttempt(input: InsertDeliveryAttemptInput): Promise<DeliveryAttempt> {
    const rows = this.attempts.get(input.deliveryJobId) ?? [];
    if (rows.some((row) => row.attemptNumber === input.attemptNumber)) {
      throw new AttemptNumberConflictError(input.deliveryJobId, input.attemptNumber);
    }

    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      startedAt: new Date(),
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
    };
    this.attempts.set(input.deliveryJobId, [...rows, attempt]);
    return attempt;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    const rows = this.attempts.get(deliveryJobId) ?? [];
    return [...rows].sort((a, b) => a.attemptNumber - b.attemptNumber);
  }
}
