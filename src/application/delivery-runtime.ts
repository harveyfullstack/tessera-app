import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { InMemoryDeliverySplitFlags } from "./delivery-split-flags";
import type { DeliverySplitFlags } from "./delivery-split-flags";
import { JobRecordService } from "./job-record-service";
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
  rpc: DeliveryAttemptRpc;
  jobRecords: JobRecordService;
}

export function createDeliveryRuntime(options?: {
  jobs?: JobRepository;
  deliveryJobs?: DeliveryJobRepository;
  deliveryAttempts?: DeliveryAttemptRepository;
  flags?: DeliverySplitFlags;
}): DeliveryRuntime {
  const jobs = options?.jobs ?? new InMemoryJobRepository();
  const deliveryJobs = options?.deliveryJobs ?? new InMemoryDeliveryJobRepository();
  const deliveryAttempts = options?.deliveryAttempts ?? new InMemoryDeliveryAttemptRepository();
  const flags = options?.flags ?? new InMemoryDeliverySplitFlags();
  const rpc = new DeliveryAttemptRpc(flags, jobs, deliveryJobs, deliveryAttempts);
  const jobRecords = new JobRecordService(jobs, rpc, flags, deliveryAttempts);

  return {
    jobs,
    deliveryJobs,
    deliveryAttempts,
    flags,
    rpc,
    jobRecords,
  };
}
