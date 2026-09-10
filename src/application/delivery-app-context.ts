import { InMemoryAccountRetryBudget } from "./account-retry-budget";
import { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import { InMemoryDeliveryAttemptRollbackFlags } from "./delivery-attempt-rollback-flags";
import { DeliveryOrchestrator } from "./delivery-orchestrator";
import { DrainDlqProcessor } from "./drain-dlq-processor";
import { JobRecordService } from "./job-record-service";
import { InMemoryDeliveryAttemptRepository } from "../infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../infrastructure/repositories/in-memory-job-repository";

export function createDeliveryAppContext() {
  const jobRepository = new InMemoryJobRepository();
  const attemptRepository = new InMemoryDeliveryAttemptRepository();
  const rollbackFlags = new InMemoryDeliveryAttemptRollbackFlags();
  const retryBudgets = new InMemoryAccountRetryBudget();
  const attemptRpc = new DeliveryAttemptRpc(jobRepository, attemptRepository, rollbackFlags);
  const jobRecords = new JobRecordService(jobRepository, attemptRpc, rollbackFlags, retryBudgets);
  const delivery = new DeliveryOrchestrator(jobRecords);
  const drainDlq = new DrainDlqProcessor(jobRecords, attemptRpc, retryBudgets, rollbackFlags);

  return {
    jobRepository,
    attemptRepository,
    rollbackFlags,
    retryBudgets,
    attemptRpc,
    jobRecords,
    delivery,
    drainDlq,
  };
}
