import type {
  CreateJobInput,
  DeliveryAttempt,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord>;
  incrementRetry(jobId: string): Promise<JobRecord>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
  appendExecution(jobId: string, input: UpdateJobExecutionInput, retry?: boolean): Promise<JobRecord>;
  attemptsForJob(jobId: string): Promise<DeliveryAttempt[]>;
}
