import type {
  CreateJobInput,
  DeliveryAttemptRecord,
  DeliveryAttemptOperation,
  JobRecord,
  JobType,
} from "./job";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  create(input: CreateJobInput): Promise<JobRecord>;
  ensureDlqEntry(
    input: CreateJobInput & { type: "drain_dlq"; parentJobId: string },
  ): Promise<JobRecord>;
  recordDeliveryAttempt(jobId: string, operation: DeliveryAttemptOperation): Promise<JobRecord>;
  listAttempts(jobId: string): Promise<DeliveryAttemptRecord[]>;
  listByBrief(briefId: string): Promise<JobRecord[]>;
}
