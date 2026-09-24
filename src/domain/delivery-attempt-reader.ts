import type { DeliveryAttemptStatus } from "./delivery-attempt";

export interface DeliveryAttemptSnapshot {
  deliveryJobId: string;
  attemptNumber: number;
  status: DeliveryAttemptStatus;
  responseStatus?: number | undefined;
  errorBody?: string | undefined;
  startedAt: Date;
  completedAt?: Date | undefined;
}

// Read-only view over delivery_attempts. One row is one execution, so the
// count is the number of real executions for a delivery job.
export interface DeliveryAttemptReader {
  countByDeliveryJob(deliveryJobId: string): Promise<number>;
  // Newest first (attempt_number DESC), at most `limit` rows.
  listLatestByDeliveryJob(deliveryJobId: string, limit: number): Promise<DeliveryAttemptSnapshot[]>;
}
