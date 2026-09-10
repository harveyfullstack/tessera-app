import { randomUUID } from "crypto";
import {
  DuplicateAttemptNumberError,
  type DeliveryAttemptRepository,
} from "../../domain/delivery-attempt-repository";
import type {
  CreateDeliveryAttemptInput,
  DeliveryAttemptRecord,
} from "../../domain/delivery-attempt";

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attempts = new Map<string, DeliveryAttemptRecord>();
  private readonly attemptNumbers = new Map<string, number>();

  async insert(
    input: CreateDeliveryAttemptInput & { attemptNumber: number },
  ): Promise<DeliveryAttemptRecord> {
    const duplicate = [...this.attempts.values()].find(
      (attempt) =>
        attempt.deliveryJobId === input.deliveryJobId &&
        attempt.attemptNumber === input.attemptNumber,
    );
    if (duplicate) {
      throw new DuplicateAttemptNumberError(input.deliveryJobId, input.attemptNumber);
    }

    const now = new Date();
    const record: DeliveryAttemptRecord = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
      startedAt: input.startedAt ?? now,
      completedAt: input.completedAt,
      createdAt: now,
    };

    this.attempts.set(record.id, record);
    const current = this.attemptNumbers.get(input.deliveryJobId) ?? 0;
    this.attemptNumbers.set(input.deliveryJobId, Math.max(current, input.attemptNumber));
    return record;
  }

  async findLatestByJobId(deliveryJobId: string): Promise<DeliveryAttemptRecord | null> {
    const rows = await this.listByJobId(deliveryJobId);
    return rows[0] ?? null;
  }

  async listByJobId(deliveryJobId: string): Promise<DeliveryAttemptRecord[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.deliveryJobId === deliveryJobId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
  }

  async nextAttemptNumber(deliveryJobId: string): Promise<number> {
    const current = this.attemptNumbers.get(deliveryJobId) ?? 0;
    const next = current + 1;
    this.attemptNumbers.set(deliveryJobId, next);
    return next;
  }

  async countByJobId(deliveryJobId: string): Promise<number> {
    return [...this.attempts.values()].filter(
      (attempt) => attempt.deliveryJobId === deliveryJobId,
    ).length;
  }
}
