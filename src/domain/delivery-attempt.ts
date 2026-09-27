import type { JobExecutionDetails, JobStatus } from "./job";

export interface DeliveryAttemptRecord {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  status: Exclude<JobStatus, "queued">;
  workerId?: string | undefined;
  errorMessage?: string | undefined;
  details?: JobExecutionDetails | undefined;
  startedAt: Date;
  completedAt?: Date | undefined;
}

export interface DeliveryAttemptStore {
  insert(attempt: DeliveryAttemptRecord): Promise<void>;
  updateLatest(
    jobId: string,
    update: Pick<DeliveryAttemptRecord, "status" | "errorMessage" | "details" | "completedAt">,
  ): Promise<DeliveryAttemptRecord | null>;
  listByJob(jobId: string): Promise<DeliveryAttemptRecord[]>;
}
