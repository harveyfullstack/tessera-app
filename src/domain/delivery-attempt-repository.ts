import type {
  DeliveryAttempt,
  DeliveryJob,
  EnsureDeliveryJobInput,
  InsertDeliveryAttemptInput,
} from "./delivery-attempt";

export interface DeliveryAttemptRepository {
  /**
   * Atomic get-or-create on (accountId, briefId, type), e.g.
   * INSERT ... ON CONFLICT (account_id, brief_id, type) DO NOTHING, then SELECT.
   */
  ensureDeliveryJob(input: EnsureDeliveryJobInput): Promise<DeliveryJob>;
  /** Highest attempt_number for the delivery job, or 0 when it has none. */
  latestAttemptNumber(deliveryJobId: string): Promise<number>;
  /**
   * Appends one attempt row. Throws AttemptNumberConflictError when
   * (deliveryJobId, attemptNumber) already exists.
   */
  insertAttempt(input: InsertDeliveryAttemptInput): Promise<DeliveryAttempt>;
  /** Attempts for the delivery job, ordered by attemptNumber ascending. */
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
}
