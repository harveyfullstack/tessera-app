import { describe, expect, test } from "bun:test";
import { server, jobRecords, dlqProcessor, jobRepository } from "../src/api/http";
import { DlqProcessor } from "../src/application/dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { CreateJobInput } from "../src/domain/job";

describe("TESSERA-1883: drain_dlq and DLQ endpoints", () => {
  const briefId = "brief-dlq-test";

  test("uses default retry budget of 8 and allows per-account configuration", () => {
    const processor = new DlqProcessor(new InMemoryJobRepository());
    expect(processor.getRetryBudget("acct-default")).toBe(8);

    processor.setRetryBudget("acct-custom", 3);
    expect(processor.getRetryBudget("acct-custom")).toBe(3);
    expect(processor.getRetryBudget("acct-default")).toBe(8);
  });

  test("drain_dlq processor moves endpoints past retry budget to Dead Letter Queue", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);
    const processor = new DlqProcessor(repo, service);

    processor.setRetryBudget("acct-custom", 3);

    // Create a job that reaches 3 retries (exceeding budget of 3)
    const job = await service.ensureJobRecord({
      accountId: "acct-custom",
      briefId,
      type: "dispatch_webhook",
      metadata: {
        customerId: "cus-1",
        subscriptionId: "sub-1",
        endpointUrl: "https://failing-webhook.com/hook",
        eventType: "order.created",
        payloadHash: "sha256:111",
      },
    });

    await service.markRunning(job.id, "worker-1");
    await service.markFailed(job.id, "timeout attempt 1");
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-2");
    await service.markFailed(job.id, "timeout attempt 2");
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-3");
    await service.markFailed(job.id, "timeout attempt 3");

    // Process drain_dlq
    const moved = await processor.processDrainDlq(briefId);
    expect(moved.length).toBe(1);
    expect(moved[0]!.id).toBe(job.id);
    expect(moved[0]!.status).toBe("failed");
    expect(moved[0]!.errorMessage).toContain("Dead Letter Queue");
  });

  test("GET /briefs/:briefId/jobs includes dlq field and supports ?status=dlq filtering", async () => {
    const testBriefId = "brief-api-dlq-" + crypto.randomUUID();
    const endpointUrl = "https://flaky-endpoint.io/receiver";

    // Set budget to 2 for this test account
    dlqProcessor.setRetryBudget("tessera-demo-account", 2);

    const job = await jobRecords.ensureJobRecord({
      accountId: "tessera-demo-account",
      briefId: testBriefId,
      type: "dispatch_webhook",
      metadata: {
        customerId: "cus-api",
        subscriptionId: "sub-api",
        endpointUrl,
        eventType: "customer.updated",
        payloadHash: "sha256:999",
      },
    });

    // Make 2 failed attempts
    await jobRecords.markRunning(job.id, "worker-api-1");
    await jobRecords.markFailed(job.id, "Error 500: Server crashed");
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-api-2");
    await jobRecords.markFailed(job.id, "Error 504: Gateway timeout");

    // Also add a healthy job in the same brief that is completed
    const healthyJob = await jobRecords.ensureJobRecord({
      accountId: "tessera-demo-account",
      briefId: testBriefId,
      type: "drain_dlq",
      metadata: {
        customerId: "cus-healthy",
        subscriptionId: "sub-healthy",
        endpointUrl: "https://healthy.io/receiver",
        eventType: "customer.created",
        payloadHash: "sha256:888",
      },
    });
    await jobRecords.markCompleted(healthyJob.id, { responseStatus: 200 });

    // Request GET without filter
    const resAll = await fetch(`http://localhost:${server.port}/briefs/${testBriefId}/jobs`);
    expect(resAll.status).toBe(200);
    const bodyAll = (await resAll.json()) as {
      jobs: unknown[];
      dlq: {
        pastBudgetCount: number;
        endpoints: Record<
          string,
          { pastBudgetCount: number; lastThreeAttemptBodies: (string | undefined)[] }
        >;
      };
    };

    expect(bodyAll.jobs.length).toBe(2);
    expect(bodyAll.dlq).toBeDefined();
    expect(bodyAll.dlq.pastBudgetCount).toBeGreaterThanOrEqual(1);
    expect(bodyAll.dlq.endpoints[endpointUrl]).toBeDefined();
    expect(bodyAll.dlq.endpoints[endpointUrl]!.pastBudgetCount).toBe(1);
    expect(bodyAll.dlq.endpoints[endpointUrl]!.lastThreeAttemptBodies.length).toBeGreaterThan(0);

    // Request GET with ?status=dlq
    const resDlq = await fetch(
      `http://localhost:${server.port}/briefs/${testBriefId}/jobs?status=dlq`,
    );
    expect(resDlq.status).toBe(200);
    const bodyDlq = (await resDlq.json()) as { jobs: Array<{ id: string }> };
    expect(bodyDlq.jobs.length).toBe(1);
    expect(bodyDlq.jobs[0]!.id).toBe(job.id);
  });
});
