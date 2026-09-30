import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRepository } from "../domain/job-repository";
import type {
  CreateJobInput,
  JobExecutionDetails,
  JobMetadata,
  JobRecord,
  JobStatus,
} from "../domain/job";

const STUCK_AFTER_MS = 5 * 60 * 1000;

export class JobRecordService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRpc = new DeliveryAttemptRpc(jobs),
    private readonly now: () => number = Date.now,
  ) {}

  async ensureJobRecord(input: CreateJobInput): Promise<JobRecord> {
    return this.jobs.ensure(input);
  }

  async markRunning(jobId: string, workerId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "running", workerId, details: { workerId } },
    });
  }

  async markFailed(
    jobId: string,
    errorMessage: string,
    details?: JobExecutionDetails,
  ): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "failed", errorMessage, details },
    });
  }

  async markCompleted(jobId: string, details: JobExecutionDetails): Promise<JobRecord> {
    return this.attempts.execute(jobId, {
      kind: "update",
      input: { status: "completed", details },
    });
  }

  async retry(jobId: string): Promise<JobRecord> {
    return this.attempts.execute(jobId, { kind: "retry" });
  }

  async listByBrief(briefId: string): Promise<JobRecord[]> {
    return this.jobs.listByBrief(briefId);
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
    if (!this.attempts.usesAttempts(job.accountId)) return job.status;
    const history = await this.jobs.listAttempts(job.deliveryJobId);
    const latest = history.reduce<(typeof history)[number] | undefined>(
      (current, attempt) => !current || attempt.attemptNumber > current.attemptNumber
        ? attempt : current,
      undefined,
    );
    if (!latest) return job.status;
    if (latest.status === "running" && this.now() - latest.startedAt.getTime() > STUCK_AFTER_MS) {
      return "stuck";
    }
    return latest.status;
  }

  async canStartNewDelivery(job: JobRecord): Promise<boolean> {
    const status = await this.displayStatus(job);
    return status !== "running";
  }
}
