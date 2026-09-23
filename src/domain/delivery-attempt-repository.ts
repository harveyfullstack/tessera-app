import type { DeliveryAttempt, NewDeliveryAttempt } from "./delivery-attempt";

// Append-only: there is deliberately no update or delete.
export interface DeliveryAttemptRepository {
  append(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt>;
  listByJob(deliveryJobId: string): Promise<DeliveryAttempt[]>;
}
