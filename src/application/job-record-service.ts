import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  DeliveryDisplayRecord,
  DeadLetterSummary,
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
    incrementRetry = false,
  ): Promise<JobRecord> {
    return this.execution.append(jobId, {
      status: "failed",
      errorMessage,
      details,
      incrementRetry,
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

  async listByBrief(briefId: string, now = new Date(), accountId?: string): Promise<DeliveryDisplayRecord[]> {
    const jobs = (await this.jobs.listByBrief(briefId)).filter((job) => !accountId || job.accountId === accountId);
    return Promise.all(jobs.map(async (job) => ({
      ...job,
      status: await this.displayStatus(job.id, now),
    })));
  }

  async deadLetterSummary(accountId: string, briefId: string): Promise<DeadLetterSummary> {
    const endpoints = await this.jobs.listDeadLetters(accountId, briefId);
    return { pastBudgetCount: new Set(endpoints.map((entry) => entry.endpointUrl)).size, endpoints };
  }

  drainDeadLetters(accountId: string, briefId: string) {
    return this.jobs.drainDeadLetters(accountId, briefId);
  }

  setRetryBudget(accountId: string, budget: number): Promise<void> {
    return this.jobs.setRetryBudget(accountId, budget);
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
