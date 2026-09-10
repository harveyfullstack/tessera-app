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
  createdAt: Date;
}

export interface CreateDeliveryJobInput {
  id?: string | undefined;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  parentJobId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
  createdAt?: Date | undefined;
}

export interface CreateDeliveryAttemptInput {
  id?: string | undefined;
  deliveryJobId: string;
  attemptNumber?: number | undefined;
  workerId?: string | undefined;
  status: JobStatus;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  startedAt?: Date | undefined;
  createdAt?: Date | undefined;
}

export interface DeliveryIntentKey {
  accountId: string;
  briefId: string;
  type: JobType;
}

export interface AttemptCountParityRow {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  type: JobType;
  oldCount: number;
  newCount: number;
}

export interface AttemptCountParityReport {
  perJob: AttemptCountParityRow[];
  oldAggregate: number;
  newAggregate: number;
  matched: boolean;
}

export function deliveryIntentKey(input: DeliveryIntentKey): string {
  return `${input.accountId}\0${input.briefId}\0${input.type}`;
}

/** Reconstructable attempt count from a pre-split jobs row. */
export function oldAttemptCountFromJob(job: {
  status: JobStatus;
  retryCount: number;
  startedAt?: Date | undefined;
}): number {
  if (job.status === "queued" && job.retryCount === 0 && job.startedAt === undefined) {
    return 0;
  }

  return job.retryCount + 1;
}
