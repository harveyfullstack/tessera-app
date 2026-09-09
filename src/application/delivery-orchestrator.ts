import { JobAlreadyRunningError } from "../domain/errors";
import { JobRecordService } from "./job-record-service";
import type { JobRecord } from "../domain/job";

export interface DeliverRequest {
  accountId: string;
  briefId: string;
  customerId: string;
  subscriptionId: string;
  endpointUrl: string;
  eventType: string;
  payloadHash: string;
  workerId: string;
  simulateFailure?: boolean;
}

export class DeliveryOrchestrator {
  constructor(private readonly jobRecords: JobRecordService) {}

  async deliver(req: DeliverRequest): Promise<JobRecord> {
    const job = await this.jobRecords.ensureWebhookDispatchJob(
      req.accountId,
      req.briefId,
      {
        customerId: req.customerId,
        subscriptionId: req.subscriptionId,
        endpointUrl: req.endpointUrl,
        eventType: req.eventType,
        payloadHash: req.payloadHash,
      },
    );

    const status = await this.jobRecords.displayStatus(job);
    if (status === "running") {
      throw new JobAlreadyRunningError(job.id);
    }

    await this.jobRecords.markRunning(job.id, req.workerId);

    if (req.simulateFailure) {
      await this.jobRecords.retry(job.id);
      return this.jobRecords.markFailed(job.id, "Simulated webhook delivery failure", {
        workerId: req.workerId,
        responseStatus: 503,
        errorBody: "endpoint returned 503 after 30s timeout",
      });
    }

    return this.jobRecords.markCompleted(job.id, {
      workerId: req.workerId,
      responseStatus: 200,
      responseLatencyMs: 187,
    });
  }
}
