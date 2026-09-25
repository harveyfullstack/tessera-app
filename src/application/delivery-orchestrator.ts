import { JobAlreadyRunningError, JobDeadLetteredError } from "../domain/errors";
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
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly dlqProcessor = new DrainDlqProcessor(jobRecords),
  ) {}

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

    if (await this.dlqProcessor.isDeadLettered(req.accountId, req.briefId, job.id)) {
      throw new JobDeadLetteredError(job.id);
    }

    if (job.status === "running") {
      throw new JobAlreadyRunningError(job.id);
    }

    await this.jobRecords.markRunning(job.id, req.workerId);

    if (req.simulateFailure) {
      await this.jobRecords.retry(job.id);
      const failedJob = await this.jobRecords.markFailed(job.id, "Simulated webhook delivery failure", {
        workerId: req.workerId,
        attemptNumber: job.retryCount + 1,
        responseStatus: 503,
        errorBody: "endpoint returned 503 after 30s timeout",
      });
      await this.dlqProcessor.process(req.accountId, req.briefId);
      return failedJob;
    }

    return this.jobRecords.markCompleted(job.id, {
      workerId: req.workerId,
      attemptNumber: job.retryCount + 1,
      responseStatus: 200,
      responseLatencyMs: 187,
    });
  }
}
