import type { DeliveryAttempt, NewDeliveryAttempt } from "./delivery-attempt";

// Append-only: there is deliberately no update or delete.
export interface DeliveryAttemptRepository {
  append(attempt: NewDeliveryAttempt): Promise<DeliveryAttempt>;
  listByJob(deliveryJobId: string): Promise<DeliveryAttempt[]>;
}

// Read side only: execution writes go through DeliveryAttemptRpc.
export type DeliveryAttemptReader = Pick<DeliveryAttemptRepository, "listByJob">;
