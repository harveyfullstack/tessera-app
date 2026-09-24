import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryDisplayRecord,
  DeliveryDisplayStatus,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

export class JobRecordService {
  readonly execution: DeliveryAttemptRpc;

  constructor(private readonly jobs: JobRepository) {
    this.execution = new DeliveryAttemptRpc(jobs);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    return this.jobs.ensureIntent(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.execution.append(jobId, {
      status: "running",
      workerId,
      details: { workerId },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.execution.append(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.execution.append(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.execution.append(jobId, { status: "queued", incrementRetry: true });
  }

  async listByBrief(briefId: string, now = new Date()): Promise<DeliveryDisplayRecord[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    return Promise.all(jobs.map(async (job) => ({
      ...job,
      status: await this.displayStatus(job.id, now),
    })));
  }

  async ensureWebhookDispatchJob(
    accountId: string,
    briefId: string,
    metadata: JobMetadata,
  ): Promise<JobRecord> {
    return this.ensureJobRecord({
      accountId,
      briefId,
      type: "dispatch_webhook",
      metadata,
    });
  }

  displayStatus(jobId: string, now = new Date()): Promise<DeliveryDisplayStatus> {
    return this.execution.displayStatus(jobId, now);
  }

  async canStartNewDelivery(jobId: string): Promise<boolean> {
    const status = await this.displayStatus(jobId);
    return status !== "running" && status !== "stuck";
  }
}
