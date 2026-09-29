import type {
  AppendDeliveryAttemptInput,
  DeliveryAttempt,
  DeliveryIntentKey,
  DeliveryJob,
} from "./delivery-attempt";

export interface DeliveryAttemptStore {
  // Looks up the intent by (accountId, briefId, type), creating it if missing.
  ensureIntent(key: DeliveryIntentKey): Promise<DeliveryJob>;
  // Assigns the next attempt_number atomically, so racing callers never collide.
  appendAttempt(input: AppendDeliveryAttemptInput): Promise<DeliveryAttempt>;
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  findIntent(deliveryJobId: string): Promise<DeliveryJob | null>;
}
