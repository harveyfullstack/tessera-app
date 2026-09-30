import { DrainDlqProcessor } from "./drain-dlq-processor";
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

    const processor = new DrainDlqProcessor(this.jobRecords);
    const drained = await processor.process(job.id);
    if (drained.status === "dlq" && !(await this.jobRecords.canStartNewDelivery(drained))) return drained;

    if (!(await this.jobRecords.canStartNewDelivery(job))) {
      throw new JobAlreadyRunningError(job.id);
    }

    const running = await this.jobRecords.markRunning(job.id, req.workerId);
    if (running.status === "dlq") return running;

    if (req.simulateFailure) {
      await this.jobRecords.retry(job.id);
      await this.jobRecords.markFailed(job.id, "Simulated webhook delivery failure", {
        workerId: req.workerId,
        attemptNumber: job.retryCount + 1,
        responseStatus: 503,
        errorBody: "endpoint returned 503 after 30s timeout",
      });
      return processor.process(job.id);
    }

    return this.jobRecords.markCompleted(job.id, {
      workerId: req.workerId,
      attemptNumber: job.retryCount + 1,
      responseStatus: 200,
      responseLatencyMs: 187,
    });
  }
}
