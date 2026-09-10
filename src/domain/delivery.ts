import type { JobMetadata, JobStatus, JobType } from "./job";

export interface DeliveryJob {
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  parentJobId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
  createdAt: Date;
}

export type DeliveryAttemptStatus = Exclude<JobStatus, "queued">;

export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: DeliveryAttemptStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date;
}

export interface AttemptCountParity {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  type: JobType;
  oldAttemptCount: number;
  newAttemptCount: number;
  matches: boolean;
}

export interface DeliverySchemaMigrationResult {
  deliveryJobs: DeliveryJob[];
  deliveryAttempts: DeliveryAttempt[];
  perJobParity: AttemptCountParity[];
  aggregateParity: {
    oldAttemptCount: number;
    newAttemptCount: number;
    matches: boolean;
  };
}
