import type {
  AggregateParityResult,
  CreateDeliveryAttemptInput,
  CreateJobInput,
  DeliveryAttemptRecord,
  DeliveryJobRecord,
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
}

export interface DeliveryJobRepository {
  findDeliveryJob(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<DeliveryJobRecord | null>;
  findDeliveryJobById(id: string): Promise<DeliveryJobRecord | null>;
  createDeliveryJob(input: CreateJobInput): Promise<DeliveryJobRecord>;
  createDeliveryAttempt(
    input: CreateDeliveryAttemptInput,
  ): Promise<DeliveryAttemptRecord>;
  listDeliveryAttempts(deliveryJobId: string): Promise<DeliveryAttemptRecord[]>;
  getLatestDeliveryAttempt(
    deliveryJobId: string,
  ): Promise<DeliveryAttemptRecord | null>;
  deleteDeliveryJob(id: string): Promise<void>;
  migrateJobsToDeliverySchema(): Promise<AggregateParityResult>;
  verifyAttemptParity(deliveryJobId?: string): Promise<AggregateParityResult>;
}
