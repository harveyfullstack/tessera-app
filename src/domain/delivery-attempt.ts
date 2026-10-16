import type { JobMetadata, JobStatus, JobType } from "./job";

// Immutable delivery intent: one row per (accountId, briefId, type).
export interface DeliveryJob {
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
  createdAt: Date;
}

export interface EnsureDeliveryJobInput {
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
}

// Append-only execution history row; never updated or deleted once written.
export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  startedAt: Date;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export type NewDeliveryAttempt = Omit<DeliveryAttempt, "id">;

export interface DeliveryAttemptWrite {
  status: JobStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}
