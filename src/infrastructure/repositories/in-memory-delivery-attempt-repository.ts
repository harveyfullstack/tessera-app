import { randomUUID } from "crypto";
import type { DeliveryAttempt } from "../../domain/delivery";
import type {
  AppendDeliveryAttemptInput,
  DeliveryAttemptRepository,
} from "../../domain/delivery-attempt-repository";

export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attempts = new Map<string, DeliveryAttempt[]>();
  private readonly tails = new Map<string, Promise<unknown>>();

  async append(deliveryJobId: string, input: AppendDeliveryAttemptInput): Promise<DeliveryAttempt> {
    return this.serialized(deliveryJobId, () => {
      const existing = this.attempts.get(deliveryJobId) ?? [];
      const latest = existing[existing.length - 1];
      const attempt: DeliveryAttempt = {
        id: randomUUID(),
        deliveryJobId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
        workerId: input.workerId,
        status: input.status,
        responseStatus: input.responseStatus,
        responseLatencyMs: input.responseLatencyMs,
        errorBody: input.errorBody,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        createdAt: new Date(),
      };

      this.attempts.set(deliveryJobId, [...existing, attempt]);
      return attempt;
    });
  }

  async listByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attempts.get(deliveryJobId) ?? [])];
  }

  async latestByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt | null> {
    const existing = this.attempts.get(deliveryJobId) ?? [];
    return existing[existing.length - 1] ?? null;
  }

  private async serialized<T>(deliveryJobId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(deliveryJobId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(deliveryJobId, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
