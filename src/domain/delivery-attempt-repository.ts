import type { DeliveryAttempt, NewDeliveryAttempt } from "./delivery-attempt";

// Append-only: there is no delete, and update only accepts the single
// running -> terminal transition enforced by the delivery_attempts trigger.
export interface DeliveryAttemptRepository {
  // Throws AttemptNumberConflictError when (deliveryJobId, attemptNumber) exists.
  insert(input: NewDeliveryAttempt): Promise<DeliveryAttempt>;
  // Ordered by attemptNumber ascending.
  listByJob(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  // The row with MAX(attempt_number) for the job, or null when it has none.
  findLatestByJob(deliveryJobId: string): Promise<DeliveryAttempt | null>;
  // Replaces the row with the same id. Throws DeliveryAttemptMutationError
  // for anything other than running -> terminal on the mutable columns.
  update(next: DeliveryAttempt): Promise<DeliveryAttempt>;
}
