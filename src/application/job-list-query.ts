import { oldAttemptCountFromJob } from "../domain/delivery";
import type { DeliveryAttempt } from "../domain/delivery";
import type { DeliveryAttemptRepository } from "../domain/delivery-repository";
import type { JobRecord } from "../domain/job";
import type { JobRepository } from "../domain/job-repository";
import type { RetryBudgetPolicy } from "./retry-budget";

export interface JobListDlqEndpoint {
  endpointUrl: string;
  attemptBodies: string[];
}

export interface JobListDlq {
  pastBudgetCount: number;
  endpoints: JobListDlqEndpoint[];
}

export interface JobListResponse {
  jobs: JobRecord[];
  dlq: JobListDlq;
}

export function attemptBody(attempt: DeliveryAttempt): string {
  if (attempt.errorBody !== undefined && attempt.errorBody.length > 0) {
    return attempt.errorBody;
  }
  if (attempt.responseStatus !== undefined) {
    return `status:${attempt.responseStatus}`;
  }
  return attempt.status;
}

export function lastThreeAttemptBodies(attempts: readonly DeliveryAttempt[]): string[] {
  return [...attempts]
    .filter((attempt) => attempt.status === "failed" || attempt.status === "completed")
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .slice(0, 3)
    .map(attemptBody);
}

export function billableAttemptCount(attempts: readonly DeliveryAttempt[]): number {
  return attempts.filter(
    (attempt) => attempt.status === "failed" || attempt.status === "completed",
  ).length;
}

export async function attemptCountForJob(
  job: JobRecord,
  deliveryAttempts: DeliveryAttemptRepository,
): Promise<number> {
  const attempts = await deliveryAttempts.listByDeliveryJobId(job.id);
  if (attempts.length > 0) {
    return billableAttemptCount(attempts);
  }
  return oldAttemptCountFromJob(job);
}

export async function buildBriefJobsResponse(
  briefId: string,
  jobs: JobRepository,
  deliveryAttempts: DeliveryAttemptRepository,
  budgets: RetryBudgetPolicy,
  statusFilter?: string,
): Promise<JobListResponse> {
  const rows = (await jobs.listByBrief(briefId)).filter((job) => job.type === "dispatch_webhook");
  const endpointBodies = new Map<string, string[]>();
  const pastBudgetJobIds = new Set<string>();

  for (const job of rows) {
    const attempts = await deliveryAttempts.listByDeliveryJobId(job.id);
    const count =
      attempts.length > 0 ? billableAttemptCount(attempts) : oldAttemptCountFromJob(job);
    if (count < budgets.budgetFor(job.accountId)) {
      continue;
    }

    pastBudgetJobIds.add(job.id);
    const bodies = lastThreeAttemptBodies(attempts);
    const existing = endpointBodies.get(job.metadata.endpointUrl) ?? [];
    endpointBodies.set(job.metadata.endpointUrl, [...bodies, ...existing].slice(0, 3));
  }

  const endpoints: JobListDlqEndpoint[] = [...endpointBodies.entries()].map(
    ([endpointUrl, attemptBodies]) => ({
      endpointUrl,
      attemptBodies,
    }),
  );

  const filtered =
    statusFilter === "dlq" ? rows.filter((job) => pastBudgetJobIds.has(job.id)) : rows;

  return {
    jobs: filtered,
    dlq: {
      pastBudgetCount: endpoints.length,
      endpoints,
    },
  };
}
