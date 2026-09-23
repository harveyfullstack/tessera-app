import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

export class JobRecordService {
  readonly rpc: DeliveryAttemptRpc;

  constructor(private readonly jobs: JobRepository, rpc?: DeliveryAttemptRpc) {
    this.rpc = rpc ?? new DeliveryAttemptRpc(jobs);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    return this.rpc.project(await this.jobs.ensureIntent(input));
  }

  markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.rpc.append(jobId, { operation: "execution", execution: {
      status: "running", workerId, details: { workerId },
    } });
  }

  markFailed(jobId: string, errorMessage: string, details?: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.append(jobId, { operation: "execution", execution: { status: "failed", errorMessage, details } });
  }

  markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.append(jobId, { operation: "execution", execution: { status: "completed", details } });
  }

  retry(jobId: string): Promise<JobRecord> {
    return this.rpc.append(jobId, { operation: "retry" });
  }

  markDeadLettered(jobId: string, expectedSequence: number): Promise<JobRecord> {
    return this.rpc.append(jobId, { operation: "execution", execution: { status: "dlq" }, expectedSequence });
  }

  listAttempts(jobId: string) {
    return this.jobs.listAttempts(jobId);
  }

  async listByBrief(briefId: string, accountId?: string): Promise<JobRecord[]> {
    return (await this.jobs.listByBrief(briefId, accountId)).map((job) => this.rpc.project(job));
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

  static displayStatus(job: JobRecord, now: Date = new Date()): string {
    if (job.executionSource !== "attempts") return job.status;
    const latest = job.latestAttempt;
    if (!latest) return "queued";
    const staleAfterMs = 5 * 60 * 1000;
    if (latest.status === "running" && latest.startedAt &&
      now.getTime() - latest.startedAt.getTime() > staleAfterMs) return "stuck";
    return latest.status;
  }

  static canStartNewDelivery(job: JobRecord): boolean {
    const status = JobRecordService.displayStatus(job);
    return !["running", "stuck", "dlq"].includes(status);
  }
}
