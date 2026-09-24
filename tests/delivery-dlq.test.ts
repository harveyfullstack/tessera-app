import { describe, expect, test } from "bun:test";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import { createHttpHandler } from "../src/api/handler";

const request = {
  accountId: "a", briefId: "brief", customerId: "customer", subscriptionId: "sub",
  endpointUrl: "https://example.com/hook", eventType: "event", payloadHash: "hash", workerId: "worker",
};

function setup() {
  const repo = new InMemoryJobRepository();
  const service = new JobRecordService(repo);
  return { repo, service, delivery: new DeliveryOrchestrator(service) };
}

describe("dead letter delivery", () => {
  test("default eight failures exhaust the budget, not running transitions", async () => {
    const { service, repo, delivery } = setup();
    for (let i = 0; i < 7; i++) await delivery.deliver({ ...request, simulateFailure: true });
    expect((await service.deadLetterSummary("a", "brief")).pastBudgetCount).toBe(0);
    const failed = await delivery.deliver({ ...request, simulateFailure: true });
    const summary = await service.deadLetterSummary("a", "brief");
    expect(summary.pastBudgetCount).toBe(1);
    expect(summary.endpoints[0]!.failedAttemptCount).toBe(8);
    expect(summary.endpoints[0]!.lastAttemptBodies).toHaveLength(3);
    expect(await repo.listAttempts(failed.id)).toHaveLength(16);
    await expect(delivery.deliver(request)).rejects.toThrow("budget exhausted");
    expect(await repo.listAttempts(failed.id)).toHaveLength(16);
    expect((await service.listByBrief("brief")).some((job) => job.type === "drain_dlq" && job.status === "completed")).toBe(true);
  });

  test("per-account budgets, success reset, rollback capture and explicit replay", async () => {
    const { service, repo, delivery } = setup();
    await service.setRetryBudget("a", 2);
    await service.execution.setEnabled("a", true);
    await delivery.deliver({ ...request, simulateFailure: true });
    await delivery.deliver(request);
    expect((await service.deadLetterSummary("a", "brief")).pastBudgetCount).toBe(0);
    await service.execution.setEnabled("a", false);
    await delivery.deliver({ ...request, simulateFailure: true });
    const failed = await delivery.deliver({ ...request, simulateFailure: true });
    await delivery.deliver({ ...request, accountId: "b", simulateFailure: true });
    expect((await service.deadLetterSummary("b", "brief")).pastBudgetCount).toBe(0);
    const previous = (await service.deadLetterSummary("a", "brief")).endpoints[0]!;
    await delivery.deadLetters.process("a", "brief");
    await delivery.deadLetters.process("a", "brief");
    expect((await service.deadLetterSummary("a", "brief")).endpoints[0]!.enqueuedAt).toEqual(previous.enqueuedAt);
    const historyLength = (await repo.listAttempts(failed.id)).length;
    await service.retry(failed.id);
    expect((await service.deadLetterSummary("a", "brief")).pastBudgetCount).toBe(0);
    await delivery.deliver(request);
    expect((await repo.listAttempts(failed.id)).length).toBe(historyLength + 3);
    expect(await repo.listLegacyAttempts(failed.id)).toEqual(await repo.listAttempts(failed.id));
    await expect(service.setRetryBudget("a", 0)).rejects.toThrow("positive integer");
  });

  test("real HTTP handler filters DLQ, scopes accounts and returns newest three bodies", async () => {
    const { service } = setup();
    await service.setRetryBudget("a", 4);
    const handler = createHttpHandler(service, "a");
    const job = await service.ensureWebhookDispatchJob("a", "brief", request);
    for (let i = 1; i <= 4; i++) {
      await service.markRunning(job.id, "worker");
      await service.markFailed(job.id, `failure-${i}`, { errorBody: `body-${i}` });
    }
    await service.ensureWebhookDispatchJob("b", "brief", { ...request, endpointUrl: "https://private.example" });
    const response = await handler(new Request("http://localhost/briefs/brief/jobs?status=dlq"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe(job.id);
    expect(body.dlq.pastBudgetCount).toBe(1);
    expect(body.dlq.endpoints[0].lastAttemptBodies).toEqual(["body-4", "body-3", "body-2"]);
    const all = await (await handler(new Request("http://localhost/briefs/brief/jobs"))).json();
    expect(all.jobs.every((row: { accountId: string }) => row.accountId === "a")).toBe(true);
    const blocked = await handler(new Request("http://localhost/deliver", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    }));
    expect(blocked.status).toBe(409);
  });

  test("success never enters DLQ and concurrent drains preserve one queue entry", async () => {
    const { service, delivery } = setup();
    await service.setRetryBudget("a", 1);
    await delivery.deliver(request);
    expect((await service.deadLetterSummary("a", "brief")).endpoints).toEqual([]);
    await delivery.deliver({ ...request, simulateFailure: true });
    await Promise.all(Array.from({ length: 12 }, () => delivery.deadLetters.process("a", "brief")));
    expect((await service.deadLetterSummary("a", "brief")).endpoints).toHaveLength(1);
  });
});
