export type JobType = "dispatch_webhook" | "drain_dlq";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobMetadata {
  customerId: string;
  subscriptionId: string;
  endpointUrl: string;
  eventType: string;
  payloadHash: string;
}

export interface JobExecutionDetails {
  workerId?: string | undefined;
  attemptNumber?: number | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export interface JobRecord {
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  parentJobId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;

  // Pre-migration shape: intent + execution state co-located on one row.
  status: JobStatus;
  workerId?: string | undefined;
  retryCount: number;
  errorMessage?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  updatedAt: Date;
  createdAt: Date;
}

export interface CreateJobInput {
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  parentJobId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
}

export interface UpdateJobExecutionInput {
  status: JobStatus;
  workerId?: string | undefined;
  errorMessage?: string | undefined;
  details?: JobExecutionDetails | undefined;
}

// Canonical Phase-2 schema: split delivery_jobs (intent) from delivery_attempts (history).
export interface DeliveryJobRecord {
  id: string;
  accountId: string;
  briefId: string;
  taskId?: string | undefined;
  parentJobId?: string | undefined;
  type: JobType;
  metadata: JobMetadata;
  createdAt: Date;
}

export interface DeliveryAttemptRecord {
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

export interface AttemptParityResult {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  type: JobType;
  oldAttemptCount: number;
  newAttemptCount: number;
  matches: boolean;
}

export interface AggregateParityResult {
  totalOldAttempts: number;
  totalNewAttempts: number;
  matches: boolean;
  jobParities: AttemptParityResult[];
}

export function computeOldAttemptCount(job: JobRecord): number {
  if (job.status === "queued" && !job.workerId && !job.startedAt && job.retryCount === 0) {
    return 0;
  }
  if (job.status === "queued" && job.retryCount > 0) {
    return job.retryCount;
  }
  return job.retryCount + 1;
}
