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

  // Compatibility projection: immutable intent plus the current execution state.
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
  incrementRetry?: boolean;
}

export type DeliveryJob = Pick<JobRecord,
  "id" | "accountId" | "briefId" | "taskId" | "parentJobId" | "type" | "metadata" | "createdAt">;

export interface DeliveryAttempt extends JobExecutionDetails {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  status: JobStatus;
  errorMessage?: string | undefined;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date;
}

export interface DeliveryRollout {
  enabled: boolean;
  enabledAt?: Date | undefined;
  rollbackUntil?: Date | undefined;
}
