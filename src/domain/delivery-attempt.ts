import type { JobStatus, JobType } from "./job";

export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date;
}

export interface CreateDeliveryAttemptInput {
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
}

export interface DeliveryIntentKey {
  accountId: string;
  briefId: string;
  type: JobType;
}
