import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  ensureDlqEntry(
    input: CreateJobInput & { type: "drain_dlq"; parentJobId: string },
  ): Promise<JobRecord>;
  updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord>;
  incrementRetry(jobId: string): Promise<JobRecord>;
  appendAttempt(
    jobId: string,
    attempt: Omit<DeliveryAttemptRecord, "jobId" | "attemptNumber" | "createdAt">,
  ): Promise<DeliveryAttemptRecord>;
  listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
}
