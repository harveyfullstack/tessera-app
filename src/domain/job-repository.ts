import type {
  CreateJobInput,
  DeadLetterEntry,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryRollout,
  JobRecord,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  setRetryBudget(accountId: string, budget: number): Promise<void>;
  drainDeadLetters(accountId: string, briefId: string): Promise<DeadLetterEntry[]>;
  listDeadLetters(accountId: string, briefId: string): Promise<DeadLetterEntry[]>;
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
