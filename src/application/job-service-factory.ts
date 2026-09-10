import type { DeliverySplitFlags } from "./delivery-split-flags";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { InMemoryDeliverySplitFlags } from "./delivery-split-flags";
import { JobRecordService } from "./job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRepository } from "../domain/job-repository";

export interface JobServiceGraph {
  jobs: JobRepository;
  attempts: DeliveryAttemptRepository;
  flags: DeliverySplitFlags;
  attemptRpc: DeliveryAttemptRpc;
  jobRecords: JobRecordService;
}

export function createJobServiceGraph(options?: {
  jobs?: JobRepository;
  attempts?: DeliveryAttemptRepository;
  flags?: DeliverySplitFlags;
}): JobServiceGraph {
  const jobs = options?.jobs ?? new InMemoryJobRepository();
  const attempts = options?.attempts ?? new InMemoryDeliveryAttemptRepository();
  const flags = options?.flags ?? new InMemoryDeliverySplitFlags();
  const attemptRpc = new DeliveryAttemptRpc(jobs, attempts, flags);

  return {
    jobs,
    attempts,
    flags,
    attemptRpc,
    jobRecords: new JobRecordService(jobs, attemptRpc),
  };
}
