import type {
  CreateJobInput,
  DeliveryAttempt,
  DeliveryJob,
  DeliveryExecutionCommand,
  JobRecord,
  JobType,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  ensure(input: CreateJobInput): Promise<JobRecord>;
  findDeliveryJob(deliveryJobId: string): Promise<DeliveryJob | null>;
  listAttempts(deliveryJobId: string): Promise<DeliveryAttempt[]>;
  // Must atomically allocate and append the attempt and update the legacy projection.
  execute(jobId: string, command: DeliveryExecutionCommand, appendAttempt: boolean): Promise<JobRecord>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
}
