import type {
  CreateDeliveryAttemptInput,
  CreateDeliveryJobInput,
  DeliveryAttempt,
  DeliveryIntentKey,
  DeliveryJob,
} from "./delivery";

export interface DeliveryJobRepository {
  findById(deliveryJobId: string): Promise<DeliveryJob | null>;
  findByIntentKey(key: DeliveryIntentKey): Promise<DeliveryJob | null>;
  create(input: CreateDeliveryJobInput): Promise<DeliveryJob>;
  listByBrief(briefId: string): Promise<DeliveryJob[]>;
  listAll(): Promise<DeliveryJob[]>;
  /** Deletes intent only. Attempts must remain (no FK CASCADE). */
  deleteById(deliveryJobId: string): Promise<void>;
}

export interface DeliveryAttemptRepository {
  findById(attemptId: string): Promise<DeliveryAttempt | null>;
  listByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  findLatestByDeliveryJobId(deliveryJobId: string): Promise<DeliveryAttempt | null>;
  insert(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt>;
  nextAttemptNumber(deliveryJobId: string): Promise<number>;
  listAll(): Promise<DeliveryAttempt[]>;
}

export class DuplicateDeliveryJobError extends Error {
  constructor(key: DeliveryIntentKey) {
    super(
      `Delivery job already exists for account=${key.accountId} brief=${key.briefId} type=${key.type}`,
    );
  }
}

export class DuplicateDeliveryAttemptError extends Error {
  constructor(deliveryJobId: string, attemptNumber: number) {
    super(
      `Delivery attempt already exists for job=${deliveryJobId} attempt_number=${attemptNumber}`,
    );
  }
}
