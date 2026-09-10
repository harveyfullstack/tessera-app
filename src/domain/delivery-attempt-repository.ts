import type { DeliveryAttempt, DeliveryAttemptStatus } from "./delivery";

export interface AppendDeliveryAttemptInput {
  workerId?: string | undefined;
  status: DeliveryAttemptStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
}

export interface DeliveryAttemptRepository {
  append(deliveryJobId: string, input: AppendDeliveryAttemptInput): Promise<DeliveryAttempt>;
  listByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  latestByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt | null>;
}
