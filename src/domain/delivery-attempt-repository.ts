import type {
  DeliveryAttempt,
  DeliveryJob,
  EnsureDeliveryJobInput,
  NewDeliveryAttempt,
} from "./delivery-attempt";
import type { JobType } from "./job";

export interface DeliveryAttemptRepository {
  // Inserts the intent if absent and always returns the canonical row for its key.
  ensureDeliveryJob(input: EnsureDeliveryJobInput): Promise<DeliveryJob>;
  findDeliveryJob(accountId: string, briefId: string, type: JobType): Promise<DeliveryJob | null>;
  latestAttemptNumber(deliveryJobId: string): Promise<number>;
  // Rejects a duplicate (deliveryJobId, attemptNumber) and never updates an existing row.
  insertAttempt(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt>;
  // Newest attempt first.
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
}
