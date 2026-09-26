import { randomUUID } from "crypto";
import type {
  CreateDeliveryAttemptInput,
  DeliveryAttempt,
} from "../../domain/delivery-attempt";
import type { DeliveryAttemptRepository } from "../../domain/delivery-attempt-repository";

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attempts = new Map<string, DeliveryAttempt[]>();

  async listByJobId(jobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attempts.get(jobId) ?? [])].sort(
      (a, b) => a.attemptNumber - b.attemptNumber,
    );
  }

  async insert(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt> {
    const jobAttempts = this.attempts.get(input.deliveryJobId) ?? [];
    if (jobAttempts.some((attempt) => attempt.attemptNumber === input.attemptNumber)) {
      throw new Error(
        `Delivery attempt already exists: ${input.deliveryJobId}#${input.attemptNumber}`,
      );
    }

    const attempt: DeliveryAttempt = {
      ...input,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.attempts.set(input.deliveryJobId, [...jobAttempts, attempt]);
    return attempt;
  }
}
