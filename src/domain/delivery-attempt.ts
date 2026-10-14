import type { JobMetadata, JobStatus, JobType } from "./job";

/** Immutable delivery intent: one row per (accountId, briefId, type). */
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
  /** Preferred id when the intent does not exist yet; ignored when it does. */
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
}

/**
 * Append-only execution history. One row is one execution write routed
 * through DeliveryAttemptRpc, numbered per delivery job from 1.
 */
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

export interface InsertDeliveryAttemptInput {
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}
