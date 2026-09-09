import type { JobStatus } from "./job";

export interface DeliveryAttemptRecord {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt: Date;
  completedAt?: Date | undefined;
  createdAt: Date;
}

export interface CreateDeliveryAttemptInput {
  deliveryJobId: string;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
}
