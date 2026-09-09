import type {
  CreateDeliveryAttemptInput,
  DeliveryAttemptRecord,
} from "./delivery-attempt";

export interface DeliveryAttemptRepository {
  insert(input: CreateDeliveryAttemptInput & { attemptNumber: number }): Promise<DeliveryAttemptRecord>;
  findLatestByJobId(deliveryJobId: string): Promise<DeliveryAttemptRecord | null>;
  listByJobId(deliveryJobId: string): Promise<DeliveryAttemptRecord[]>;
  nextAttemptNumber(deliveryJobId: string): Promise<number>;
  countByJobId(deliveryJobId: string): Promise<number>;
}
