import type { CreateJobInput, JobRecord, JobType } from "./job";
import type {
  AppendExecutionInput, DeliveryAttempt, DeliveryIntent, DeliveryParity, DeliveryRollout,
} from "./delivery-attempt";

export interface JobRepository {
  findByBriefAndType(briefId: string, type: JobType, accountId?: string): Promise<JobRecord[]>;
  findById(jobId: string): Promise<JobRecord | null>;
  ensureIntent(input: CreateJobInput): Promise<JobRecord>;
  listByBrief(briefId: string, accountId?: string): Promise<JobRecord[]>;
  getIntent(jobId: string): Promise<DeliveryIntent | null>;
  getLegacySnapshot(jobId: string): Promise<JobRecord | null>;
  listAttempts(jobId: string): Promise<DeliveryAttempt[]>;
  // Adapter must allocate sequence, capture history and mirror legacy in one transaction.
  appendExecution(jobId: string, input: AppendExecutionInput,
    source: (accountId: string) => "legacy" | "attempts"): Promise<JobRecord>;
  getParity(accountId: string): DeliveryParity;
  getRollout(accountId: string): DeliveryRollout;
  setRollout(accountId: string, rollout: DeliveryRollout): void;
}
