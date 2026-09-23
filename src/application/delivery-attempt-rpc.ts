import type { JobRepository } from "../domain/job-repository";
import type { AppendExecutionInput, DeliveryParity, DeliveryRollout } from "../domain/delivery-attempt";
import type { JobRecord } from "../domain/job";

const ROLLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class DeliveryAttemptRpc {
  constructor(private readonly jobs: JobRepository, private readonly clock: () => Date = () => new Date()) {}

  append(jobId: string, input: AppendExecutionInput): Promise<JobRecord> {
    return this.jobs.appendExecution(jobId, input, (accountId) => this.source(accountId));
  }

  source(accountId: string): "legacy" | "attempts" {
    return this.jobs.getRollout(accountId).enabled ? "attempts" : "legacy";
  }

  project(job: JobRecord): JobRecord {
    return { ...job, executionSource: this.source(job.accountId) };
  }

  getRollout(accountId: string): DeliveryRollout {
    return this.jobs.getRollout(accountId);
  }

  getParity(accountId: string): DeliveryParity {
    return this.jobs.getParity(accountId);
  }

  enableAccount(accountId: string): DeliveryRollout {
    if (!this.getParity(accountId).matches) throw new Error("Delivery cutover blocked: forward parity or duplicate intent check failed");
    const current = this.getRollout(accountId);
    if (current.enabled) return current;
    const enabledAt = this.clock();
    const rollout = { enabled: true, enabledAt,
      rollbackUntil: new Date(enabledAt.getTime() + ROLLBACK_WINDOW_MS) };
    this.jobs.setRollout(accountId, rollout);
    return structuredClone(rollout);
  }

  rollbackAccount(accountId: string): DeliveryRollout {
    const current = this.getRollout(accountId);
    if (!current.enabled) return current;
    // Stores remain retained beyond the guaranteed fourteen-day window.
    const rollout = { ...current, enabled: false };
    this.jobs.setRollout(accountId, rollout);
    return rollout;
  }
}
