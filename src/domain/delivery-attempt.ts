import type { JobExecutionDetails, JobRecord, JobStatus, UpdateJobExecutionInput } from "./job";

export type DeliveryIntent = Pick<JobRecord,
  "id" | "accountId" | "briefId" | "taskId" | "parentJobId" | "type" | "metadata" | "createdAt">;

export interface DeliveryAttempt {
  id: string;
  jobId: string;
  accountId: string;
  attemptNumber: number;
  operation: "execution" | "retry";
  status: JobStatus;
  workerId?: string | undefined;
  retryCount: number;
  errorMessage?: string | undefined;
  details: JobExecutionDetails;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  createdAt: Date;
}

export type AppendExecutionInput =
  | { operation: "execution"; execution: UpdateJobExecutionInput; expectedSequence?: number }
  | { operation: "retry" };

export interface DeliveryParity {
  accountId: string;
  legacyEventCount: number;
  attemptCount: number;
  unresolvedDuplicateKeys: number;
  jobs: { jobId: string; legacyEventCount: number; attemptCount: number; matches: boolean }[];
  matches: boolean;
}

export interface DeliveryRollout {
  enabled: boolean;
  enabledAt?: Date | undefined;
  rollbackUntil?: Date | undefined;
}
