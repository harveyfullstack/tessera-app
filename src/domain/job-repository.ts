import type {
  CreateJobInput,
  DeliveryAttempt,
  DlqSummary,
  JobListOptions,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord>;
  appendAttempt(jobId: string, input: UpdateJobExecutionInput): Promise<DeliveryAttempt>;
  incrementRetry(jobId: string): Promise<JobRecord>;
  listByBrief(briefId: string, options?: JobListOptions): Promise<JobRecord[]>;
  getDlqSummary(briefId: string): Promise<DlqSummary>;
}
