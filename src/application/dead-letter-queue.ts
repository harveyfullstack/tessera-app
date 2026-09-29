import type { DeliveryAttempt } from "../domain/delivery-attempt";
import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type { JobRecord } from "../domain/job";
import { latestAttempt, type JobRecordService } from "./job-record-service";

export const DLQ_ATTEMPT_BODY_LIMIT = 3;

// Keyed only by (deliveryJobId, attemptNumber): attempt rows carry no endpoint identity.
export interface DlqAttemptBody {
  deliveryJobId: string;
  attemptNumber: number;
  body: string;
}

export interface DlqEntry {
  deliveryJobId: string;
  // The delivery job's existing metadata.endpointUrl.
  endpointUrl: string;
  jobIds: string[];
  lastAttemptBodies: DlqAttemptBody[];
}

export interface DlqSummary {
  count: number;
  entries: DlqEntry[];
}

// Every RPC call appends a row (running, failed, queued, ...), so attempt_number
// and the raw row count overstate how often delivery was tried. Each real try
// starts with exactly one "running" row, which is what the budget counts.
export function deliveryTries(attempts: readonly DeliveryAttempt[]): number {
  return attempts.filter((attempt) => attempt.status === "running").length;
}

// Past budget: the budget's worth of tries has been spent and the latest attempt
// is a failure or a pending retry. In-flight, completed, cancelled and
// already dead-lettered jobs are never moved.
export function isPastRetryBudget(attempts: readonly DeliveryAttempt[], budget: number): boolean {
  const latest = latestAttempt(attempts);
  if (!latest || (latest.status !== "failed" && latest.status !== "queued")) {
    return false;
  }

  return deliveryTries(attempts) >= budget;
}

export function lastAttemptBodies(attempts: readonly DeliveryAttempt[]): DlqAttemptBody[] {
  return [...attempts]
    .filter((attempt) => attempt.errorBody !== undefined)
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .slice(0, DLQ_ATTEMPT_BODY_LIMIT)
    .map((attempt) => ({
      deliveryJobId: attempt.deliveryJobId,
      attemptNumber: attempt.attemptNumber,
      body: attempt.errorBody ?? "",
    }));
}

function groupByDeliveryJob(jobs: readonly JobRecord[]): Map<string, JobRecord[]> {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    if (job.deliveryJobId) {
      groups.set(job.deliveryJobId, [...(groups.get(job.deliveryJobId) ?? []), job]);
    }
  }
  return groups;
}

// Read side of the DLQ: jobs whose display status is "dlq", grouped by delivery job.
export class DeadLetterQueue {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly attempts: DeliveryAttemptStore,
  ) {}

  async summarizeBrief(briefId: string, now: Date = new Date()): Promise<DlqSummary> {
    const deadLettered = await this.jobRecords.listByBriefWithDisplayStatus(briefId, "dlq", now);
    const groups = groupByDeliveryJob(deadLettered);

    const entries = await Promise.all(
      [...groups].map(([deliveryJobId, jobs]) => this.entryFor(deliveryJobId, jobs)),
    );

    return { count: entries.length, entries };
  }

  private async entryFor(deliveryJobId: string, jobs: readonly JobRecord[]): Promise<DlqEntry> {
    const [intent, attempts] = await Promise.all([
      this.attempts.findIntent(deliveryJobId),
      this.attempts.listAttempts(deliveryJobId),
    ]);

    return {
      deliveryJobId,
      endpointUrl: intent?.metadata.endpointUrl ?? jobs[0]?.metadata.endpointUrl ?? "",
      jobIds: jobs.map((job) => job.id),
      lastAttemptBodies: lastAttemptBodies(attempts),
    };
  }
}
