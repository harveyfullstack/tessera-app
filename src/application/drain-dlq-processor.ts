import type { JobRecord } from "../domain/job";
import type { DeadLetterQueueInspector, DlqEndpoint } from "./dead-letter-queue-inspector";
import type { JobRecordService } from "./job-record-service";

export interface DrainDlqRequest {
  accountId: string;
  briefId: string;
  workerId: string;
}

export interface DlqMove {
  drainJob: JobRecord;
  endpoint: DlqEndpoint;
}

// Processor for the drain_dlq job type. Every dispatch_webhook job in the
// brief that is past its account's retry budget moves to the Dead Letter
// Queue: a drain_dlq job is recorded as its child, and that job's run is
// written through JobRecordService so it lands in delivery_attempts.
export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly inspector: DeadLetterQueueInspector,
  ) {}

  async process(req: DrainDlqRequest): Promise<DlqMove[]> {
    const jobs = (await this.jobRecords.listByBrief(req.briefId)).filter(
      (job) => job.accountId === req.accountId,
    );

    const moves: DlqMove[] = [];
    for (const job of jobs) {
      const endpoint = await this.inspector.evaluate(job);
      const move = endpoint ? await this.moveToDlq(req, job, endpoint) : null;
      if (move) {
        moves.push(move);
      }
    }
    return moves;
  }

  private async moveToDlq(
    req: DrainDlqRequest,
    source: JobRecord,
    endpoint: DlqEndpoint,
  ): Promise<DlqMove | null> {
    // Intent is unique on (account_id, brief_id, type), so the brief has one
    // drain_dlq job. Reuse it only when it belongs to this dispatch job.
    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId: req.accountId,
      briefId: req.briefId,
      parentJobId: source.id,
      type: "drain_dlq",
      metadata: source.metadata,
    });

    if (drainJob.parentJobId !== source.id) {
      return null;
    }

    const status = await this.inspector.latestStatus(drainJob);
    if (status === "running" || status === "completed") {
      return null;
    }

    await this.jobRecords.markRunning(drainJob.id, req.workerId);
    const completed = await this.jobRecords.markCompleted(drainJob.id, {
      workerId: req.workerId,
    });
    return { drainJob: completed, endpoint };
  }
}
