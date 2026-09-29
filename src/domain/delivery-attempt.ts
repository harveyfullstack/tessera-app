import type { JobMetadata, JobRecord, JobStatus, JobType } from "./job";

// Immutable delivery intent, unique per (accountId, briefId, type).
export interface DeliveryJob {
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
  createdAt: Date;
}

// delivery_attempts.status is free text in the schema; writes stay within JobStatus.
export type DeliveryAttemptStatus = JobStatus;

// Append-only execution history row. Never updated or deleted.
export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: DeliveryAttemptStatus;
  startedAt: Date;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export type DeliveryIntentKey = Pick<
  JobRecord,
  "accountId" | "briefId" | "taskId" | "type" | "metadata"
>;

// attemptNumber is intentionally absent: the store assigns it atomically.
export interface AppendDeliveryAttemptInput {
  deliveryJobId: string;
  status: DeliveryAttemptStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

// Per-account write-path flags. Both sets ship empty; ids are added at rollout.
export interface DeliveryWritePathFlags {
  pilotAccountIds: ReadonlySet<string>;
  rollbackAccountIds: ReadonlySet<string>;
}
