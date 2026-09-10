import type {
  CreateDeliveryAttemptInput,
  CreateJobInput,
  DeliveryAttempt,
  DeliveryJob,
  JobType,
} from "./job";

export interface DeliveryJobRepository {
  findByAccountBriefAndType(
    accountId: string,
    briefId: string,
    type: JobType,
  ): Promise<DeliveryJob | null>;
  findById(jobId: string): Promise<DeliveryJob | null>;
  create(input: CreateJobInput): Promise<DeliveryJob>;
  appendAttempt(input: CreateDeliveryAttemptInput): Promise<DeliveryAttempt>;
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
}
