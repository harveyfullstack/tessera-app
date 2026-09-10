import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobRecordService } from "../src/application/job-record-service";
import { JobAlreadyRunningError } from "../src/domain/errors";
import { InMemoryRollbackFeatureFlag } from "../src/infrastructure/in-memory-rollback-feature-flag";
import { InMemoryDeliveryJobRepository } from "../src/infrastructure/repositories/in-memory-delivery-job-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

function createService() {
  const jobs = new InMemoryJobRepository();
  const deliveryJobs = new InMemoryDeliveryJobRepository();
  const rollbackFlag = new InMemoryRollbackFeatureFlag();
  const rpc = new DeliveryAttemptRpc(jobs, deliveryJobs, rollbackFlag);
  return new JobRecordService(jobs, rpc, deliveryJobs, rollbackFlag);
}

const baseRequest = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-us-east-04",
} as const;

describe("DeliveryOrchestrator", () => {
  test("completes a happy-path webhook delivery", async () => {
    const service = createService();
    const orchestrator = new DeliveryOrchestrator(service);

    const result = await orchestrator.deliver({
      ...baseRequest,
      simulateFailure: false,
    });

    expect(result.status).toBe("completed");
    expect(result.retryCount).toBe(0);
  });

  test("marks a failed run and increments retry count when simulateFailure is set", async () => {
    const service = createService();
    const orchestrator = new DeliveryOrchestrator(service);

    const result = await orchestrator.deliver({
      ...baseRequest,
      simulateFailure: true,
    });

    expect(result.status).toBe("failed");
    expect(result.retryCount).toBe(1);
    expect(result.errorMessage).toContain("Simulated webhook delivery failure");
  });

  test("rejects a second deliver while the latest attempt is running", async () => {
    const service = createService();
    const orchestrator = new DeliveryOrchestrator(service);
    const job = await service.ensureWebhookDispatchJob(
      baseRequest.accountId,
      baseRequest.briefId,
      {
        customerId: baseRequest.customerId,
        subscriptionId: baseRequest.subscriptionId,
        endpointUrl: baseRequest.endpointUrl,
        eventType: baseRequest.eventType,
        payloadHash: baseRequest.payloadHash,
      },
    );
    await service.markRunning(job.id, baseRequest.workerId);

    await expect(orchestrator.deliver({ ...baseRequest })).rejects.toBeInstanceOf(
      JobAlreadyRunningError,
    );
  });
});
