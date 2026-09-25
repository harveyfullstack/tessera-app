import { describe, expect, test } from "bun:test";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobDeadLetteredError } from "../src/domain/errors";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import { hasValidBearerToken } from "../src/api/bearer-auth";

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
  test("accepts only a matching bearer token", () => {
    const request = (authorization?: string) =>
      new Request("https://example.test/briefs/brief-1/jobs", {
        headers: authorization ? { authorization } : {},
      });

    expect(hasValidBearerToken(request("Bearer secret-token"), "secret-token")).toBe(true);
    expect(hasValidBearerToken(request("Bearer wrong-token"), "secret-token")).toBe(false);
    expect(hasValidBearerToken(request(), "secret-token")).toBe(false);
  });

  test("completes a happy-path webhook delivery", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const orchestrator = new DeliveryOrchestrator(service);

    const result = await orchestrator.deliver({
      ...baseRequest,
      simulateFailure: false,
    });

    expect(result.status).toBe("completed");
    expect(result.retryCount).toBe(0);
  });

  test("marks a failed run and increments retry count when simulateFailure is set", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const orchestrator = new DeliveryOrchestrator(service);

    const result = await orchestrator.deliver({
      ...baseRequest,
      simulateFailure: true,
    });

    expect(result.status).toBe("failed");
    expect(result.retryCount).toBe(1);
    expect(result.errorMessage).toContain("Simulated webhook delivery failure");
  });

  test("does not retry a delivery after it reaches the DLQ budget", async () => {
    const repository = new InMemoryJobRepository();
    const service = new JobRecordService(repository);
    const orchestrator = new DeliveryOrchestrator(service);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await orchestrator.deliver({ ...baseRequest, simulateFailure: true });
    }

    await expect(
      orchestrator.deliver({ ...baseRequest, simulateFailure: true }),
    ).rejects.toBeInstanceOf(JobDeadLetteredError);

    const [job] = await repository.findByBriefAndType(
      baseRequest.briefId,
      "dispatch_webhook",
    );
    expect(job).toBeDefined();
    const attempts = await repository.listAttempts(job!.id);
    expect(attempts).toHaveLength(24);
    expect(attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(8);
  });
});
