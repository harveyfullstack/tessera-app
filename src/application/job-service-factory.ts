import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { DrainDlqProcessor } from "./drain-dlq-processor";
import type { DeliverySplitFlags } from "./delivery-split-flags";
import { InMemoryDeliverySplitFlags } from "./delivery-split-flags";
import { JobRecordService } from "./job-record-service";
import { RetryBudgetPolicy } from "./retry-budget-policy";
import type { DeadLetterQueue } from "../domain/dead-letter-queue";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";
import { InMemoryDeadLetterQueue } from "../infrastructure/repositories/in-memory-dead-letter-queue";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

export interface JobServiceGraph {
  jobs: JobRepository;
  attempts: DeliveryAttemptRepository;
  flags: DeliverySplitFlags;
  attemptRpc: DeliveryAttemptRpc;
  jobRecords: JobRecordService;
  budgets: RetryBudgetPolicy;
  dlq: DeadLetterQueue;
  drainDlq: DrainDlqProcessor;
}

export function createJobServiceGraph(options?: {
  jobs?: JobRepository;
  attempts?: DeliveryAttemptRepository;
  flags?: DeliverySplitFlags;
  budgets?: RetryBudgetPolicy;
  dlq?: DeadLetterQueue;
}): JobServiceGraph {
  const jobs = options?.jobs ?? new InMemoryJobRepository();
  const attempts = options?.attempts ?? new InMemoryDeliveryAttemptRepository();
  const flags = options?.flags ?? new InMemoryDeliverySplitFlags();
  const budgets = options?.budgets ?? new RetryBudgetPolicy();
  const dlq = options?.dlq ?? new InMemoryDeadLetterQueue();
  const attemptRpc = new DeliveryAttemptRpc(jobs, attempts, flags);
  const jobRecords = new JobRecordService(jobs, attemptRpc, attempts, flags);

  return {
    jobs,
    attempts,
    flags,
    attemptRpc,
    jobRecords,
    budgets,
    dlq,
    drainDlq: new DrainDlqProcessor(jobRecords, attempts, budgets, dlq),
  };
}
