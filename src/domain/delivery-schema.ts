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

export interface DeliveryJobSource {
  legacyJobId: string;
  deliveryJobId: string;
  isCanonical: boolean;
}

export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export interface AttemptCountParity {
  deliveryJobId: string;
  legacyAttemptCount: number;
  deliveryAttemptCount: number;
}

export interface AttemptCountAggregate {
  legacyAttemptCount: number;
  deliveryAttemptCount: number;
}

export interface AttemptParityProof {
  ok: boolean;
  reason?: string | undefined;
  byJob: AttemptCountParity[];
  aggregate: AttemptCountAggregate;
}

export interface DeliveryMigrationResult {
  deliveryJobs: DeliveryJob[];
  attempts: DeliveryAttempt[];
  sources: DeliveryJobSource[];
  parityByJob: AttemptCountParity[];
  aggregate: AttemptCountAggregate;
}
