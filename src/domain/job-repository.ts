import type {
  CreateJobInput,
  DeliveryAttempt,
  DlqEntry,
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
  appendAttempt(jobId: string, input: UpdateJobExecutionInput): Promise<DeliveryAttempt>;
  listAttempts(jobId: string): Promise<DeliveryAttempt[]>;
  enqueueDlq(entry: DlqEntry): Promise<void>;
  listDlq(briefId: string): Promise<DlqEntry[]>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
}
