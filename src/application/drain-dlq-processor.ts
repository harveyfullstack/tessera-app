import type { JobRecord } from "../domain/job";
import { JobRecordService } from "./job-record-service";

export interface DrainDlqResult {
  movedJobIds: string[];
  drainJob: JobRecord;
}

export class DrainDlqProcessor {
  constructor(private readonly jobRecords: JobRecordService) {}

  async process(briefId: string, accountId = "system"): Promise<DrainDlqResult> {
    const jobs = await this.jobRecords.listIntentByBrief(briefId);
    const moved: JobRecord[] = [];

    for (const job of jobs) {
      if (job.type !== "dispatch_webhook" || job.deadLetteredAt) {
        continue;
      }
      if (await this.jobRecords.isPastRetryBudget(job)) {
        moved.push(await this.jobRecords.markDeadLettered(job.id));
      }
    }

    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId: moved[0]?.accountId ?? jobs[0]?.accountId ?? accountId,
      briefId,
      type: "drain_dlq",
      metadata: {
        customerId: "system",
        subscriptionId: "drain_dlq",
        endpointUrl: "dlq://tessera",
        eventType: "delivery.drain_dlq",
        payloadHash: "sha256:drain_dlq",
        movedEndpointUrls: moved.map((job) => job.metadata.endpointUrl),
      },
    });

    if (moved.length > 0) {
      await this.jobRecords.markCompleted(drainJob.id, {
        workerId: "drain_dlq",
        attemptNumber: moved.length,
      });
    }

    const refreshed = await this.jobRecords.findById(drainJob.id);
    return {
      movedJobIds: moved.map((job) => job.id),
      drainJob: refreshed ?? drainJob,
    };
  }
}
