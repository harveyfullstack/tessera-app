import type { DeadLetterQueue } from "../domain/dead-letter";
import type { DeliveryAttemptRepository } from "../domain/delivery-repository";
import type { JobMetadata, JobRecord } from "../domain/job";
import type { JobRepository } from "../domain/job-repository";
import { attemptCountForJob, lastThreeAttemptBodies } from "./job-list-query";
import type { JobRecordService } from "./job-record-service";
import type { RetryBudgetPolicy } from "./retry-budget";

export interface DrainDlqRequest {
  accountId: string;
  briefId: string;
  workerId: string;
}

export interface DrainDlqResult {
  job: JobRecord;
  movedJobIds: string[];
}

export function drainDlqMetadata(briefId: string): JobMetadata {
  return {
    customerId: "tessera-internal",
    subscriptionId: `dlq:${briefId}`,
    endpointUrl: "dlq://internal",
    eventType: "delivery.drain_dlq",
    payloadHash: `sha256:dlq:${briefId}`,
  };
}

export class DrainDlqProcessor {
  constructor(
    private readonly jobRecords: JobRecordService,
    private readonly jobs: JobRepository,
    private readonly deliveryAttempts: DeliveryAttemptRepository,
    private readonly budgets: RetryBudgetPolicy,
    private readonly dlq: DeadLetterQueue,
  ) {}

  async process(req: DrainDlqRequest): Promise<DrainDlqResult> {
    const drainJob = await this.jobRecords.ensureJobRecord({
      accountId: req.accountId,
      briefId: req.briefId,
      type: "drain_dlq",
      metadata: drainDlqMetadata(req.briefId),
    });

    await this.jobRecords.markRunning(drainJob.id, req.workerId);

    const movedJobIds: string[] = [];
    const webhooks = (await this.jobs.listByBrief(req.briefId)).filter(
      (job) => job.type === "dispatch_webhook" && job.accountId === req.accountId,
    );

    for (const webhook of webhooks) {
      const budget = this.budgets.budgetFor(webhook.accountId);
      const attemptCount = await attemptCountForJob(webhook, this.deliveryAttempts);
      if (attemptCount < budget) {
        continue;
      }

      const attempts = await this.deliveryAttempts.listByDeliveryJobId(webhook.id);
      this.dlq.bind({
        deliveryJobId: webhook.id,
        accountId: webhook.accountId,
        briefId: webhook.briefId,
        endpointUrl: webhook.metadata.endpointUrl,
        attemptCount,
        lastAttemptBodies: lastThreeAttemptBodies(attempts),
      });
      movedJobIds.push(webhook.id);
    }

    const completed = await this.jobRecords.markCompleted(drainJob.id, {
      workerId: req.workerId,
      attemptNumber: movedJobIds.length,
    });

    return { job: completed, movedJobIds };
  }
}
