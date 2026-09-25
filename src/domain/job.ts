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

// Running/retry record RPC events; completed/failed are terminal delivery outcomes.
export type DeliveryAttemptStatus =
  | "running"
  | "retry"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface DeliveryAttemptRecord {
  jobId: string;
  attemptNumber: number;
  status: DeliveryAttemptStatus;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
  createdAt: Date;
}

export type DeliveryAttemptOperation =
  | { type: "mark_running"; workerId: string }
  | { type: "mark_failed"; errorMessage: string; details?: JobExecutionDetails | undefined }
  | { type: "mark_completed"; details: JobExecutionDetails }
  | { type: "retry" };

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
