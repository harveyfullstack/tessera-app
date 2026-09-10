import type { CreateDeliveryAttemptInput, DeliveryAttempt } from "./delivery-attempt";
import type {
  CreateJobInput,
  JobRecord,
  JobType,
  UpdateJobExecutionInput,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findByAccountBriefAndType(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<JobRecord | null>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  updateExecution(jobId: string, input: UpdateJobExecutionInput): Promise<JobRecord>;
  incrementRetry(jobId: string): Promise<JobRecord>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
  insertAttempt(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt>;
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  getLatestAttempt(deliveryJobId: string): Promise<DeliveryAttempt | null>;
  deleteDeliveryJob(jobId: string): Promise<void>;
}
