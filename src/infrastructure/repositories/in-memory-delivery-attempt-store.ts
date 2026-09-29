import { randomUUID } from "crypto";
import type { DeliveryAttemptStore } from "../../domain/delivery-attempt-store";
import type {
  AppendDeliveryAttemptInput,
  DeliveryAttempt,
  DeliveryIntentKey,
  DeliveryJob,
} from "../../domain/delivery-attempt";

function intentKey(key: DeliveryIntentKey): string {
  return JSON.stringify([key.accountId, key.briefId, key.type]);
}

// Each method reads and writes without an intervening await, so the in-memory
// store gives the same guarantees as the Postgres RPC's row lock: one intent
// per key and strictly increasing attempt numbers under concurrent callers.
export class InMemoryDeliveryAttemptStore implements DeliveryAttemptStore {
  private readonly intentsByKey = new Map<string, DeliveryJob>();
  private readonly intentsById = new Map<string, DeliveryJob>();
  private readonly attempts = new Map<string, readonly DeliveryAttempt[]>();

  async ensureIntent(key: DeliveryIntentKey): Promise<DeliveryJob> {
    const existing = this.intentsByKey.get(intentKey(key));
    if (existing) {
      return existing;
    }

    const intent: DeliveryJob = {
      id: randomUUID(),
      accountId: key.accountId,
      briefId: key.briefId,
      taskId: key.taskId,
      type: key.type,
      metadata: key.metadata,
      createdAt: new Date(),
    };

    this.intentsByKey.set(intentKey(key), intent);
    this.intentsById.set(intent.id, intent);
    return intent;
  }

  async appendAttempt(input: AppendDeliveryAttemptInput): Promise<DeliveryAttempt> {
    if (!this.intentsById.has(input.deliveryJobId)) {
      throw new Error(`Delivery job not found: ${input.deliveryJobId}`);
    }

    const history = this.attempts.get(input.deliveryJobId) ?? [];
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: history.length + 1,
      workerId: input.workerId,
      status: input.status,
      startedAt: new Date(),
      responseStatus: input.responseStatus,
      responseLatencyMs: input.responseLatencyMs,
      errorBody: input.errorBody,
    };

    this.attempts.set(input.deliveryJobId, [...history, attempt]);
    return attempt;
  }

  async listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...(this.attempts.get(deliveryJobId) ?? [])];
  }

  async findIntent(deliveryJobId: string): Promise<DeliveryJob | null> {
    return this.intentsById.get(deliveryJobId) ?? null;
  }
}
