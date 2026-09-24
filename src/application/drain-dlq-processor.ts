import type { DeadLetterEntry, DeadLetterQueue } from "../domain/dead-letter-queue";
import type { JobRecord } from "../domain/job";
import type { DlqInspector } from "./dlq-inspector";
import type { JobRecordService } from "./job-record-service";

export class InvalidDrainJobError extends Error {
  constructor(jobId: string, type: string) {
    super(`Job ${jobId} is ${type}, expected drain_dlq`);
  }
}

export interface DrainDlqResult {
  drainJob: JobRecord;
  moved: DeadLetterEntry[];
}

// Processes one execution of a brief's drain_dlq job: every webhook dispatch
// in the same account and brief that is past its retry budget moves to the
// Dead Letter Queue. Re-running is safe because enqueue is idempotent per
// delivery job.
export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly inspector: DlqInspector,
    private readonly deadLetters: DeadLetterQueue,
  ) {}

  async process(drainJob: JobRecord, workerId: string): Promise<DrainDlqResult> {
    if (drainJob.type !== "drain_dlq") {
      throw new InvalidDrainJobError(drainJob.id, drainJob.type);
    }

    await this.jobRecords.markRunning(drainJob.id, workerId);

    try {
      const moved = await this.moveDlqBound(drainJob);
      const completed = await this.jobRecords.markCompleted(drainJob.id, { workerId });
      return { drainJob: completed, moved };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobRecords.markFailed(drainJob.id, message, { workerId, errorBody: message });
      throw error;
    }
  }

  private async moveDlqBound(drainJob: JobRecord): Promise<DeadLetterEntry[]> {
    const briefJobs = await this.jobRecords.listByBrief(drainJob.briefId);
    const candidates = briefJobs.filter((job) => job.accountId === drainJob.accountId);
    const dlqBound = await this.inspector.findDlqBound(candidates);

    const enqueuedAt = new Date();
    const moved: DeadLetterEntry[] = [];
    for (const endpoint of dlqBound) {
      const entry: DeadLetterEntry = { ...endpoint, enqueuedAt };
      if (await this.deadLetters.enqueue(entry)) {
        moved.push(entry);
      }
    }

    return moved;
  }
}
