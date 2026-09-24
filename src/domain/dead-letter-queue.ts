import type { DeliveryAttemptSnapshot } from "./delivery-attempt-reader";

export interface DeadLetterEntry {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  endpointUrl: string;
  attemptCount: number;
  retryBudget: number;
  lastAttempts: readonly DeliveryAttemptSnapshot[];
  enqueuedAt: Date;
}

export interface DeadLetterQueue {
  // Idempotent per delivery job: returns false when the job is already queued.
  enqueue(entry: DeadLetterEntry): Promise<boolean>;
  listByBrief(briefId: string): Promise<DeadLetterEntry[]>;
}
