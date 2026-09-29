import { DeliveryAttemptRpc, type RollbackFlag } from "./delivery-attempt-rpc";
import { JobNotFoundError } from "../domain/errors";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";

export type RetryBudget = (accountId: string) => number;

export class JobRecordService {
  private readonly rpc: DeliveryAttemptRpc;
  private readonly rollbackEnabled: RollbackFlag;

  constructor(
    private readonly jobs: JobRepository,
    rollbackEnabled: RollbackFlag = () => false,
    private readonly retryBudget: RetryBudget = () => 8,
  ) {
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

  async listByBrief(briefId: string, status?: string): Promise<(JobRecord & { displayStatus: string })[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    const rows = await Promise.all(jobs.map(async (job) => ({
      ...job,
      displayStatus: await this.displayStatus(job),
    })));
    return status ? rows.filter((job) => job.displayStatus === status) : rows;
  }

  async processDrainDlq(jobId: string): Promise<JobRecord> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    if (job.type !== "dispatch_webhook" || job.retryCount < this.retryBudget(job.accountId) || await this.displayStatus(job) === "dlq") {
      return job;
    }
    return this.rpc.write(jobId, { status: "dlq" });
  }

  async dlqSummary(briefId: string): Promise<{
    count: number;
    endpoints: { deliveryJobId: string; endpointUrl: string; attempts: { attemptNumber: number; errorBody?: string | undefined }[] }[];
  }> {
    const jobs = await this.listByBrief(briefId, "dlq");
    return {
      count: jobs.length,
      endpoints: await Promise.all(jobs.map(async (job) => {
        const attempts = await this.jobs.attemptsForJob(job.id);
        return {
          deliveryJobId: job.deliveryJobId ?? job.id,
          endpointUrl: job.metadata.endpointUrl,
          attempts: attempts.filter((attempt) => attempt.errorBody !== undefined).slice(-3)
            .map(({ attemptNumber, errorBody }) => ({ attemptNumber, errorBody })),
        };
      })),
    };
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
    return status !== "running" && status !== "dlq";
  }
}
