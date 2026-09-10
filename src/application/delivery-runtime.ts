import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { DrainDlqProcessor } from "./drain-dlq-processor";
import { InMemoryDeliverySplitFlags } from "./delivery-split-flags";
import type { DeliverySplitFlags } from "./delivery-split-flags";
import { JobRecordService } from "./job-record-service";
import { InMemoryRetryBudgetPolicy } from "./retry-budget";
import type { DeadLetterQueue } from "../domain/dead-letter";
import { InMemoryDeadLetterQueue } from "../domain/dead-letter";
import type { DeliveryAttemptRepository, DeliveryJobRepository } from "../domain/delivery-repository";
import type { JobRepository } from "../domain/job-repository";
import {
  InMemoryDeliveryAttemptRepository,
  InMemoryDeliveryJobRepository,
} from "../infrastructure/repositories/in-memory-delivery-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

export interface DeliveryRuntime {
  jobs: JobRepository;
  deliveryJobs: DeliveryJobRepository;
  deliveryAttempts: DeliveryAttemptRepository;
  flags: DeliverySplitFlags;
  budgets: InMemoryRetryBudgetPolicy;
  dlq: DeadLetterQueue;
  rpc: DeliveryAttemptRpc;
  jobRecords: JobRecordService;
  drainDlq: DrainDlqProcessor;
}

export function createDeliveryRuntime(options?: {
  jobs?: JobRepository;
  deliveryJobs?: DeliveryJobRepository;
  deliveryAttempts?: DeliveryAttemptRepository;
  flags?: DeliverySplitFlags;
  budgets?: InMemoryRetryBudgetPolicy;
  dlq?: DeadLetterQueue;
}): DeliveryRuntime {
  const jobs = options?.jobs ?? new InMemoryJobRepository();
  const deliveryJobs = options?.deliveryJobs ?? new InMemoryDeliveryJobRepository();
  const deliveryAttempts = options?.deliveryAttempts ?? new InMemoryDeliveryAttemptRepository();
  const flags = options?.flags ?? new InMemoryDeliverySplitFlags();
  const budgets = options?.budgets ?? new InMemoryRetryBudgetPolicy();
  const dlq = options?.dlq ?? new InMemoryDeadLetterQueue();
  const rpc = new DeliveryAttemptRpc(flags, jobs, deliveryJobs, deliveryAttempts);
  const jobRecords = new JobRecordService(jobs, rpc, flags, deliveryAttempts);
  const drainDlq = new DrainDlqProcessor(jobRecords, jobs, deliveryAttempts, budgets, dlq);

  return {
    jobs,
    deliveryJobs,
    deliveryAttempts,
    flags,
    budgets,
    dlq,
    rpc,
    jobRecords,
    drainDlq,
  };
}
