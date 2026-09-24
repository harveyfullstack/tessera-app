import type { DeliveryAttemptStore } from "../domain/delivery-attempt-store";
import type { JobRepository } from "../domain/job-repository";
import type { JobRecord } from "../domain/job";
import { AccountRetryBudgets } from "../domain/retry-budget";

export interface DlqEndpoint {
  accountId: string;
  endpointUrl: string;
  bodies: string[];
}

interface AttemptTrace {
  at: number;
  attemptNumber: number;
  errorBody?: string | undefined;
}

interface EndpointBucket {
  accountId: string;
  endpointUrl: string;
  traces: AttemptTrace[];
}

const LAST_BODIES = 3;

export class DlqDrainProcessor {
  private readonly drained = new Map<string, DlqEndpoint[]>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly attempts: DeliveryAttemptStore,
    private readonly budgets: AccountRetryBudgets = new AccountRetryBudgets(),
  ) {}

  async drain(job: JobRecord): Promise<DlqEndpoint[]> {
    if (job.type !== "drain_dlq") {
      throw new Error(`drain_dlq processor cannot run ${job.type}`);
    }

    const endpoints = await this.endpointsPastBudget(job.briefId);
    this.drained.set(job.briefId, endpoints);
    return endpoints;
  }

  drainedEndpoints(briefId: string): readonly DlqEndpoint[] {
    return this.drained.get(briefId) ?? [];
  }

  async endpointsPastBudget(briefId: string): Promise<DlqEndpoint[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    const grouped = await this.groupByEndpoint(jobs);
    const endpoints: DlqEndpoint[] = [];
    for (const bucket of grouped.values()) {
      if (bucket.traces.length <= this.budgets.forAccount(bucket.accountId)) {
        continue;
      }
      endpoints.push({
        accountId: bucket.accountId,
        endpointUrl: bucket.endpointUrl,
        bodies: latestBodies(bucket.traces),
      });
    }
    return endpoints.sort(byEndpointUrl);
  }

  private async groupByEndpoint(jobs: readonly JobRecord[]): Promise<Map<string, EndpointBucket>> {
    const grouped = new Map<string, EndpointBucket>();
    for (const job of jobs) {
      const key = `${job.accountId}\0${job.metadata.endpointUrl}`;
      const bucket = grouped.get(key) ?? {
        accountId: job.accountId,
        endpointUrl: job.metadata.endpointUrl,
        traces: [],
      };
      bucket.traces.push(...(await this.tracesFor(job)));
      grouped.set(key, bucket);
    }
    return grouped;
  }

  private async tracesFor(job: JobRecord): Promise<AttemptTrace[]> {
    const rows = await this.attempts.list(job.id);
    return rows.map((row) => ({
      at: job.createdAt.getTime(),
      attemptNumber: row.attemptNumber,
      ...(row.errorBody !== undefined ? { errorBody: row.errorBody } : {}),
    }));
  }
}

function latestBodies(traces: readonly AttemptTrace[]): string[] {
  const ordered = [...traces].sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    return left.attemptNumber - right.attemptNumber;
  });
  const bodies: string[] = [];
  for (let index = ordered.length - 1; index >= 0 && bodies.length < LAST_BODIES; index -= 1) {
    const body = ordered[index]?.errorBody;
    if (body !== undefined) {
      bodies.push(body);
    }
  }
  return bodies;
}

function byEndpointUrl(left: DlqEndpoint, right: DlqEndpoint): number {
  if (left.endpointUrl < right.endpointUrl) {
    return -1;
  }
  if (left.endpointUrl > right.endpointUrl) {
    return 1;
  }
  return 0;
}
