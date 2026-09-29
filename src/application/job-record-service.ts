import { DeliveryAttemptRpc, type RollbackFlag } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;
  private readonly rollbackEnabled: RollbackFlag;

  constructor(private readonly jobs: JobRepository, rollbackEnabled: RollbackFlag = () => false) {
    this.rollbackEnabled = rollbackEnabled;
    this.rpc = new DeliveryAttemptRpc(jobs, rollbackEnabled);
  }

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    const existing = await this.jobs.findByBriefAndType(input.briefId, input.type);
    const canonical = existing.find((job) => job.accountId === input.accountId);
    if (canonical) {
      return canonical;
    }

    // The repository enforces the canonical (account, brief, type) intent key.
    return this.jobs.create(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.rpc.write(jobId, {
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
    return this.rpc.write(jobId, {
      status: "failed",
      errorMessage,
      details,
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.rpc.write(jobId, {
      status: "completed",
      details,
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.rpc.write(jobId, { status: "queued" }, true);
  }

  async listByBrief(briefId: string): Promise<(JobRecord & { displayStatus: string })[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    const rows = await Promise.all(jobs.map(async (job) => ({
      ...job,
      displayStatus: await this.displayStatus(job),
    })));
    return rows;
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

  async displayStatus(job: JobRecord): Promise<JobStatus | "stuck"> {
    if (this.rollbackEnabled(job.accountId)) return job.status;
    const attempts = await this.jobs.attemptsForJob(job.id);
    const latest = attempts.at(-1);
    if (!latest) return "queued";
    if (latest.status === "running" && Date.now() - latest.startedAt.getTime() > 5 * 60_000) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }
}
