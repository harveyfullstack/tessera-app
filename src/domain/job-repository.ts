import type {
  CreateJobInput,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryRollout,
  JobRecord,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  findById(jobId: string): Promise<JobRecord | null>;
  ensureIntent(input: CreateJobInput): Promise<JobRecord>;
  appendExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
  listAttempts(jobId: string): Promise<DeliveryAttempt[]>;
  listLegacyAttempts(jobId: string): Promise<DeliveryAttempt[]>;
  findIntent(jobId: string): Promise<DeliveryJob | null>;
  getRollout(accountId: string): Promise<DeliveryRollout>;
  setRollout(accountId: string, enabled: boolean): Promise<DeliveryRollout>;
}
