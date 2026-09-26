import type { JobRepository } from "../domain/job-repository";
import type { DlqEntry } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export interface DlqSummary {
  count: number;
  endpoints: DlqEntry[];
}

export class DlqService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly records: JobRecordService,
    private readonly retryBudget: (accountId: string) => number = () => 8,
  ) {}

  private async candidates(accountId: string, briefId: string): Promise<DlqEntry[]> {
    const jobs = await this.jobs.listByBrief(briefId);
    const entries = await Promise.all(jobs
      .filter((job) => job.accountId === accountId && job.type === "dispatch_webhook")
      .map(async (job) => {
        const attempts = await this.jobs.listAttempts(job.id);
        const failures = attempts.filter((attempt) => attempt.status === "failed");
        const budget = this.retryBudget(accountId);
        if (!Number.isInteger(budget) || budget < 1) throw new Error("Invalid DLQ retry budget");
        if (failures.length < budget) return null;
        return {
          jobId: job.id,
          accountId,
          briefId,
          endpointUrl: job.metadata.endpointUrl,
          attemptBodies: attempts.slice(-3).map((attempt) => attempt.errorBody ?? ""),
        };
      }));
    return entries.filter((entry): entry is DlqEntry => entry !== null);
  }

  async summary(accountId: string, briefId: string): Promise<DlqSummary> {
    const endpoints = await this.candidates(accountId, briefId);
    return { count: endpoints.length, endpoints };
  }

  async drain(accountId: string, briefId: string, workerId: string): Promise<number> {
    const candidates = await this.candidates(accountId, briefId);
    const existing = new Set((await this.jobs.listDlq(briefId)).map((entry) => entry.jobId));
    const pending = candidates.filter((entry) => !existing.has(entry.jobId));
    if (pending.length === 0) return 0;
    const source = await this.jobs.findById(pending[0]!.jobId);
    if (!source) throw new Error("DLQ source job disappeared");
    const drainJob = await this.records.ensureJobRecord({
      accountId, briefId, type: "drain_dlq", metadata: source.metadata,
    });
    await this.records.markRunning(drainJob.id, workerId);
    try {
      for (const entry of pending) await this.jobs.enqueueDlq(entry);
      await this.records.markCompleted(drainJob.id, { workerId });
      return pending.length;
    } catch (error) {
      await this.records.markFailed(drainJob.id, String(error), { workerId });
      throw error;
    }
  }
}
