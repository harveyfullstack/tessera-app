import { describe, expect, test } from "bun:test";
import { createHttpHandler } from "../src/api/http-handler";
import { AccountRetryBudgets, DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "customer", subscriptionId: "subscription", endpointUrl: "https://hooks.example.test",
  eventType: "anomaly.detected", payloadHash: "sha256:payload",
};

async function failedDeliveries(service: JobRecordService, accountId: string, count: number) {
  const job = await service.ensureWebhookDispatchJob(accountId, "brief", metadata);
  for (let index = 1; index <= count; index += 1) {
    await service.markRunning(job.id, "worker");
    await service.markFailed(job.id, `failure ${index}`, { errorBody: `body ${index}`, responseStatus: 503 });
    await service.retry(job.id);
  }
  return job;
}

describe("dead-letter processing", () => {
  test("default budget counts failed executions, not lifecycle or retry events", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const processor = new DrainDlqProcessor(service);
    const job = await failedDeliveries(service, "account", 7);
    await processor.process("account", "brief", "drainer");
    expect((await service.listByBrief("brief", "account")).find((row) => row.id === job.id)?.status).toBe("failed");
    await service.markRunning(job.id, "worker");
    await service.markFailed(job.id, "eighth failure", { errorBody: "body 8" });
    const drain = await processor.process("account", "brief", "drainer");
    expect(drain?.type).toBe("drain_dlq");
    expect(drain?.status).toBe("completed");
    expect((await service.listByBrief("brief", "account")).find((row) => row.id === job.id)?.status).toBe("dlq");
    const events = await service.listAttempts(job.id);
    await processor.process("account", "brief", "drainer");
    expect((await service.listAttempts(job.id)).length).toBe(events.length);
  });

  test("account override is isolated and latest successful deliveries are excluded", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const processor = new DrainDlqProcessor(service, new AccountRetryBudgets(new Map([["pilot", 2]])));
    await failedDeliveries(service, "pilot", 2);
    const control = await failedDeliveries(service, "control", 2);
    await processor.process("pilot", "brief", "drainer");
    expect((await service.listByBrief("brief", "pilot")).find((job) => job.type === "dispatch_webhook")?.status).toBe("dlq");
    expect((await service.listByBrief("brief", "control"))[0]?.status).toBe("failed");
    await service.markCompleted(control.id, { responseStatus: 200 });
    expect((await processor.summarize(await service.listByBrief("brief", "control"))).pastBudgetCount).toBe(0);
  });

  test("HTTP filters DLQ and reports three actual execution bodies without crossing accounts", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    await failedDeliveries(service, "account", 8);
    await failedDeliveries(service, "other", 8);
    const handler = createHttpHandler(service, "account");
    const drained = await handler(new Request("http://localhost/briefs/brief/drain-dlq", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: "drainer" }),
    }));
    expect(drained.status).toBe(200);
    const response = await handler(new Request("http://localhost/briefs/brief/jobs?status=dlq"));
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].accountId).toBe("account");
    expect(body.dlq.pastBudgetCount).toBe(1);
    expect(body.dlq.endpoints[0].lastAttempts.map((attempt: { details: { errorBody: string } }) => attempt.details.errorBody))
      .toEqual(["body 8", "body 7", "body 6"]);
    expect((await service.listByBrief("brief", "other"))[0]?.status).toBe("failed");
  });

  test("empty briefs do not manufacture work and invalid budgets are rejected", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const processor = new DrainDlqProcessor(service);
    expect(await processor.process("account", "missing", "worker")).toBeNull();
    expect(await processor.summarize([])).toEqual({ pastBudgetCount: 0, endpoints: [] });
    for (const budget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new AccountRetryBudgets(new Map([["account", budget]]))).toThrow();
    }
  });

  test("draining a stale failed snapshot cannot overwrite a newer execution", async () => {
    const service = new JobRecordService(new InMemoryJobRepository());
    const job = await failedDeliveries(service, "account", 8);
    const previous = (await service.listAttempts(job.id)).at(-1)!;
    await service.markRunning(job.id, "new-worker");
    const current = await service.markDeadLettered(job.id, previous.attemptNumber);
    expect(current.status).toBe("running");
  });
});

test("drain endpoint rejects malformed or missing worker bodies", async () => {
  const handler = createHttpHandler(new JobRecordService(new InMemoryJobRepository()), "account");
  for (const body of ["null", "{}", "{", JSON.stringify({ workerId: " " })]) {
    const response = await handler(new Request("http://localhost/briefs/brief/drain-dlq", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect(response.status).toBe(400);
  }
});

test("dead-lettered deliveries cannot be restarted by a racing or subsequent caller", async () => {
  const service = new JobRecordService(new InMemoryJobRepository());
  const job = await failedDeliveries(service, "account", 8);
  await new DrainDlqProcessor(service).process("account", "brief", "drainer");
  const before = await service.listAttempts(job.id);
  await expect(service.markRunning(job.id, "worker")).rejects.toThrow("dead letter queue");
  expect(await service.listAttempts(job.id)).toEqual(before);
});
