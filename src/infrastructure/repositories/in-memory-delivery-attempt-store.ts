import { DuplicateDeliveryAttemptError } from "../../domain/errors";
import type { DeliveryAttemptStore } from "../../domain/delivery-attempt-store";
import type { DeliveryAttempt } from "../../domain/delivery-schema";

export class InMemoryDeliveryAttemptStore implements DeliveryAttemptStore {
  private readonly rows = new Map<string, DeliveryAttempt[]>();

  async insert(attempt: DeliveryAttempt): Promise<void> {
    const existing = this.rows.get(attempt.deliveryJobId) ?? [];
    if (existing.some((row) => row.attemptNumber === attempt.attemptNumber)) {
      throw new DuplicateDeliveryAttemptError(attempt.deliveryJobId, attempt.attemptNumber);
    }

    this.rows.set(attempt.deliveryJobId, [...existing, attempt]);
  }

  async list(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    const existing = this.rows.get(deliveryJobId) ?? [];
    return [...existing].sort((left, right) => left.attemptNumber - right.attemptNumber);
  }

  async latest(deliveryJobId: string): Promise<DeliveryAttempt | null> {
    const rows = await this.list(deliveryJobId);
    return rows.at(-1) ?? null;
  }
}
