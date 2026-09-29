import { JobNotFoundError, UnexpectedJobTypeError } from "../domain/errors";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type { JobRepository } from "../domain/job-repository";
import type { JobRecord } from "../domain/job";
import { isPastRetryBudget } from "./dead-letter-queue";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { RetryBudgetPolicy } from "./retry-budget-policy";

export interface DrainDlqResult {
  drainJob: JobRecord;
  deadLetteredJobIds: string[];
}

// Processor for the drain_dlq job type: moves the brief's webhook deliveries
// that are past their account's retry budget into the dead letter queue.
// Reads come from the stores; every execution write goes through the RPC.
export class DrainDlqProcessor {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptStore,
    private readonly executionWrites: DeliveryAttemptRpc,
    private readonly retryBudget: RetryBudgetPolicy,
  ) {}

  async process(drainJobId: string, workerId: string): Promise<DrainDlqResult> {
    const drainJob = await this.jobs.findById(drainJobId);
    if (!drainJob) {
      throw new JobNotFoundError(drainJobId);
    }
    if (drainJob.type !== "drain_dlq") {
      throw new UnexpectedJobTypeError(drainJobId, "drain_dlq", drainJob.type);
    }

    await this.executionWrites.markRunning(drainJob.id, workerId);

    try {
      const deadLetteredJobIds = await this.drain(drainJob, workerId);
      const completed = await this.executionWrites.markCompleted(drainJob.id, { workerId });
      return { drainJob: completed, deadLetteredJobIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.executionWrites.markFailed(drainJob.id, message, { workerId });
      throw error;
    }
  }

  private async drain(drainJob: JobRecord, workerId: string): Promise<string[]> {
    const candidates = await this.candidates(drainJob);
    const budget = this.retryBudget.budgetFor(drainJob.accountId);
    const moved: string[] = [];

    // Sequential on purpose: each move appends to the attempt history.
    for (const job of candidates) {
      const attempts = job.deliveryJobId ? await this.attempts.listAttempts(job.deliveryJobId) : [];
      if (isPastRetryBudget(attempts, budget)) {
        await this.executionWrites.markDeadLettered(job.id, workerId);
        moved.push(job.id);
      }
    }

    return moved;
  }

  // Webhook deliveries in the same account and brief that record attempts. Legacy
  // path accounts have no attempt history to count tries from, so they are
  // skipped. Duplicate jobs rows share one intent; only the first is moved.
  private async candidates(drainJob: JobRecord): Promise<JobRecord[]> {
    if (!this.executionWrites.usesAttemptPath(drainJob.accountId)) {
      return [];
    }

    const seen = new Set<string>();
    const jobs = await this.jobs.listByBrief(drainJob.briefId);
    return jobs.filter((job) => {
      if (
        job.type !== "dispatch_webhook" ||
        job.accountId !== drainJob.accountId ||
        !job.deliveryJobId ||
        seen.has(job.deliveryJobId)
      ) {
        return false;
      }
      seen.add(job.deliveryJobId);
      return true;
    });
  }
}
