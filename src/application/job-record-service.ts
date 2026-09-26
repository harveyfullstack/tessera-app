import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
} from "../domain/job";

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;

  constructor(
    private readonly jobs: JobRepository,
    rollbackEnabled: (accountId: string) => boolean = () => false,
  ) {
    this.rpc = new DeliveryAttemptRpc(jobs, rollbackEnabled);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing.find((job) => job.accountId === input.accountId);
    if (canonical) {
      return canonical;
    }

    // The repository enforces the unique account/brief/type key atomically.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.rpc.write(jobId, "running", { workerId });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.rpc.write(jobId, "failed", details, errorMessage);
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.write(jobId, "completed", details);
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.rpc.write(jobId, "queued");
  }

  async listByBrief(briefId: string): Promise<(Omit<JobRecord, "status"> & { status: string })[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    return Promise.all(jobs.map(async (job) => ({ ...job, status: await this.displayStatus(job) })));
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

  async displayStatus(job: JobRecord): Promise<string> {
    if (this.rpc.isRollbackEnabled(job.accountId)) return job.status;
    const attempts = await this.jobs.listAttempts(job.id);
    const latest = attempts.reduce(
      (current, attempt) => !current || attempt.attemptNumber > current.attemptNumber ? attempt : current,
      undefined as (typeof attempts)[number] | undefined,
    );
    if (!latest) return "queued";
    if (latest.status === "running" && Date.now() - latest.startedAt.getTime() > 5 * 60_000) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    return (await this.displayStatus(job)) !== "running";
  }
}
