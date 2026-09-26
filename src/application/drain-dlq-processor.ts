import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import type { JobRecord, JobType } from "../domain/job";
import type { RetryBudgetResolver } from "./retry-budget";
import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";

export type DlqJobRecord = Omit<JobRecord, "status"> & { status: "dlq" };

export interface DrainDlqCommand {
  type: Extract<JobType, "drain_dlq">;
  briefId: string;
}

export interface DlqEndpoint {
  accountId: string;
  deliveryJobId: string;
  endpointUrl: string;
  attemptBodies: string[];
}

export interface DrainDlqResult {
  jobs: DlqJobRecord[];
  dlq: {
    pastBudgetCount: number;
    endpoints: DlqEndpoint[];
  };
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptRepository,
    private readonly deliveryAttemptRpc: DeliveryAttemptRpc,
    private readonly retryBudgetForAccount: RetryBudgetResolver,
  ) {}

  async process(command: DrainDlqCommand): Promise<DrainDlqResult> {
    const dispatchJobs = (await this.jobs.listByBrief(command.briefId)).filter(
      (job) => job.type === "dispatch_webhook",
    );
    const results = await Promise.all(
      dispatchJobs.map(async (job) => {
        const usesLegacyWrites = this.deliveryAttemptRpc.usesLegacyWrites(
          job.accountId,
        );
        const [projected, history] = await Promise.all([
          this.deliveryAttemptRpc.getJobRecord(job.id),
          usesLegacyWrites
            ? Promise.resolve([])
            : this.attempts.listByJobId(job.id),
        ]);
        const failedAttempts = history.filter(
          (attempt) => attempt.status === "failed",
        ).length;
        const fallbackFailures = Math.max(
          projected.retryCount,
          projected.status === "failed" ? 1 : 0,
        );
        const attemptsUsed = history.length > 0 ? failedAttempts : fallbackFailures;
        const eligibleStatus =
          projected.status === "failed" || projected.status === "queued";
        const isPastBudget =
          eligibleStatus &&
          attemptsUsed > 0 &&
          attemptsUsed >= this.retryBudgetForAccount(projected.accountId);

        const attemptBodies = history
          .map((attempt) => attempt.errorBody)
          .filter((body): body is string => body !== undefined);
        if (attemptBodies.length === 0 && projected.errorMessage) {
          attemptBodies.push(projected.errorMessage);
        }

        return {
          job: projected,
          isPastBudget,
          attemptBodies: attemptBodies.slice(-3),
        };
      }),
    );
    const deadLetterJobs = results.filter((result) => result.isPastBudget);

    return {
      jobs: deadLetterJobs.map(({ job }) => ({ ...job, status: "dlq" })),
      dlq: {
        pastBudgetCount: deadLetterJobs.length,
        endpoints: deadLetterJobs.map(({ job, attemptBodies }) => ({
          accountId: job.accountId,
          deliveryJobId: job.id,
          endpointUrl: job.metadata.endpointUrl,
          attemptBodies,
        })),
      },
    };
  }
}
