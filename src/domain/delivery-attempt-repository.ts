import type {
  CreateDeliveryAttemptInput,
  DeliveryAttempt,
} from "./delivery-attempt";

export interface DeliveryAttemptRepository {
  listByJobId(jobId: string): Promise<DeliveryAttempt[]>;
  insert(attempt: CreateDeliveryAttemptInput): Promise<DeliveryAttempt>;
}
