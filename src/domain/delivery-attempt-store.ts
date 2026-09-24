import type { DeliveryAttempt } from "./delivery-schema";

export interface DeliveryAttemptStore {
  insert(attempt: DeliveryAttempt): Promise<void>;
  list(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  latest(deliveryJobId: string): Promise<DeliveryAttempt | null>;
}
