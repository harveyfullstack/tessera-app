import { JobAlreadyRunningError } from "../domain/errors";
import { DrainDlqProcessor } from "./drain-dlq-processor";
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
  readonly deadLetters: DrainDlqProcessor;

  constructor(private readonly jobRecords: JobRecordService) {
    this.deadLetters = new DrainDlqProcessor(jobRecords);
  }

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

    if (!(await this.jobRecords.canStartNewDelivery(job.id))) {
      throw new JobAlreadyRunningError(job.id);
    }

    await this.jobRecords.markRunning(job.id, req.workerId);

    if (req.simulateFailure) {
      const failed = await this.jobRecords.markFailed(job.id, "Simulated webhook delivery failure", {
        workerId: req.workerId,
        attemptNumber: job.retryCount + 1,
        responseStatus: 503,
        errorBody: "endpoint returned 503 after 30s timeout",
      }, true);
      await this.deadLetters.process(req.accountId, req.briefId);
      return failed;
    }

    return this.jobRecords.markCompleted(job.id, {
      workerId: req.workerId,
      attemptNumber: job.retryCount + 1,
      responseStatus: 200,
      responseLatencyMs: 187,
    });
  }
}
