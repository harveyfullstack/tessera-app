import type { JobRepository } from "../domain/job-repository";
import { deriveAttemptDisplayStatus } from "../domain/delivery-display-status";
import type {
  CreateJobInput,
  JobDisplayStatus,
  JobExecutionDetails,
  JobListing,
  JobMetadata,
  JobRecord,
} from "../domain/job";
import { InMemoryDeliveryRollbackFlag } from "../infrastructure/flags/in-memory-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly executions: DeliveryAttemptRpc = new DeliveryAttemptRpc(
      jobs,
      new InMemoryDeliveryAttemptRepository(),
      new InMemoryDeliveryRollbackFlag(),
    ),
    // Clock for the stuck-attempt threshold; injectable for deterministic tests.
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing[0];
    if (canonical) {
      return canonical;
    }

    // Pre-migration behavior. If two callers race, duplicate intent rows are possible.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.executions.markRunning(jobId, workerId);
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.executions.markFailed(jobId, errorMessage, details);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.executions.markCompleted(jobId, details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.executions.retry(jobId);
  }

  // Same fields as the stored rows, with status replaced by the display status.
  async listByBrief(briefId: string): Promise<JobListing[]> {
    const rows = await this.jobs.listByBrief(briefId);
    return Promise.all(
      rows.map(async (job) => ({ ...job, status: await this.displayStatus(job) })),
    );
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

  async displayStatus(job: JobRecord): Promise<JobDisplayStatus> {
    const state = await this.executions.readExecutionState(job);
    if (state.source === "jobs") {
      return state.status;
    }

    return deriveAttemptDisplayStatus(state.latest, this.now());
  }

  // A stuck attempt does not block a new delivery; only a live running one does.
  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    return (await this.displayStatus(job)) !== "running";
  }
}
