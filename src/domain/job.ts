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

  // Rollback snapshot of the pre-split jobs row. Intent lives on delivery_jobs;
  // execution history lives on delivery_attempts. These fields stay writable
  // only when the rollback flag is on.
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
