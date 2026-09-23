import { randomUUID } from "crypto";
import { DeliveryAttemptConflictError } from "../../domain/errors";
import type { DeliveryAttemptRepository } from "../../domain/delivery-attempt-repository";
import type { DeliveryAttempt, NewDeliveryAttempt } from "../../domain/delivery-attempt";

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attemptsByJob = new Map<string, readonly DeliveryAttempt[]>();

  async append(input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const existing = this.attemptsByJob.get(input.deliveryJobId) ?? [];
    // Mirrors the unique index on (delivery_job_id, attempt_number).
    if (existing.some((attempt) => attempt.attemptNumber === input.attemptNumber)) {
      throw new DeliveryAttemptConflictError(input.deliveryJobId, input.attemptNumber);
    }

    const attempt: DeliveryAttempt = {
      ...input,
      id: randomUUID(),
      backfilled: false,
      createdAt: new Date(),
    };

    this.attemptsByJob.set(input.deliveryJobId, [...existing, attempt]);
    return attempt;
  }

  async listByJob(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attemptsByJob.get(deliveryJobId) ?? [])].sort(
      (a, b) => a.attemptNumber - b.attemptNumber,
    );
  }
}
