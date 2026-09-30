export type JobType = "dispatch_webhook" | "drain_dlq";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dlq";

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

  deliveryJobId: string;

  // Retained execution projection makes per-account rollback executable.
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

export interface DeliveryJob extends CreateJobInput {
  id: string;
  createdAt: Date;
}

export interface DeliveryAttempt {
  legacyRetryCount: number;
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  status: JobStatus;
  startedAt: Date;
  workerId?: string | undefined;
  responseStatus?: number | undefined;
  responseLatencyMs?: number | undefined;
  errorBody?: string | undefined;
}

export type DeliveryExecutionCommand =
  | { kind: "update"; input: UpdateJobExecutionInput }
  | { kind: "retry" }
  | { kind: "drain_dlq"; retryBudget: number };

export interface DeliveryDlqSummary {
  deliveryJobId: string;
  endpointUrl: string;
  retryBudget: number;
  failureCount: number;
  pastBudgetCount: number;
  attempts: DeliveryAttempt[];
}

export function deliveryFailureCount(history: readonly DeliveryAttempt[], legacyRetryCounts: readonly number[]): number {
  const baseline = history.reduce<DeliveryAttempt | undefined>((first, row) =>
    !first || row.attemptNumber < first.attemptNumber ? row : first, undefined)?.legacyRetryCount ?? 0;
  return Math.max(baseline + history.filter((row) => row.status === "failed").length,
    0, ...legacyRetryCounts);
}
