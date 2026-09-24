import { JobAlreadyRunningError } from "../domain/errors";
import type { DeadLetterEntry } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export class DrainDlqProcessor {
  private readonly active = new Map<string, Promise<DeadLetterEntry[]>>();

  constructor(private readonly records: JobRecordService) {}

  process(accountId: string, briefId: string): Promise<DeadLetterEntry[]> {
    const key = JSON.stringify([accountId, briefId]);
    const existing = this.active.get(key);
    if (existing) return existing;
    const work = this.run(accountId, briefId).finally(() => this.active.delete(key));
    this.active.set(key, work);
    return work;
  }

  private async run(accountId: string, briefId: string): Promise<DeadLetterEntry[]> {
    const jobs = await this.records.listByBrief(briefId, new Date(), accountId);
    const source = jobs.find((job) => job.type === "dispatch_webhook" && job.status === "failed");
    if (!source) return [];
    const drain = await this.records.ensureJobRecord({
      accountId, briefId, type: "drain_dlq", parentJobId: source.id, metadata: source.metadata,
    });
    try {
      await this.records.markRunning(drain.id, "dlq-processor");
    } catch (error) {
      if (error instanceof JobAlreadyRunningError) {
        return (await this.records.deadLetterSummary(accountId, briefId)).endpoints;
      }
      throw error;
    }
    try {
      const refreshed = await this.records.drainDeadLetters(accountId, briefId);
      await this.records.markCompleted(drain.id, {});
      return refreshed;
    } catch (error) {
      await this.records.markFailed(drain.id, error instanceof Error ? error.message : "DLQ processing failed");
      throw error;
    }
  }
}
