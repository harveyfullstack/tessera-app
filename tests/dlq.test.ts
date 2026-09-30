import { describe, expect, test } from "bun:test";
import { createHttpHandler } from "../src/api/handler";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { DeliveryOrchestrator } from "../src/application/delivery-orchestrator";
import { DrainDlqProcessor } from "../src/application/drain-dlq-processor";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { DeliveryDlqSummary, DeliveryExecutionCommand, JobRecord } from "../src/domain/job";

const request = {
  accountId: "tessera-demo-account", briefId: "brief", customerId: "customer",
  subscriptionId: "subscription", endpointUrl: "https://original.example",
  eventType: "event", payloadHash: "hash", workerId: "worker", simulateFailure: true,
};
function fixture(budget?: number) {
  const repo = new InMemoryJobRepository();
  const rollbackAccounts = new Set<string>();
  const rpc = new DeliveryAttemptRpc(repo, { pilotAccounts: new Set([request.accountId]), rollbackAccounts });
  const service = new JobRecordService(repo, rpc, Date.now,
    budget === undefined ? new Map() : new Map([[request.accountId, budget]]));
  return { repo, service, rollbackAccounts, delivery: new DeliveryOrchestrator(service) };
}

describe("drain_dlq", () => {
  test("default budget allows eight failed deliveries then prevents all further execution", async () => {
    const { repo, service, delivery } = fixture();
    for (let index = 1; index <= 8; index++) {
      const result = await delivery.deliver(request);
      expect(result.status).toBe(index === 8 ? "dlq" : "failed");
    }
    const [job] = await service.listByBrief(request.briefId);
    const before = await repo.listAttempts(job!.deliveryJobId);
    expect(before.filter((row) => row.status === "failed")).toHaveLength(8);
    const summary = (await service.dlqSummary(job!))!;
    expect(summary.pastBudgetCount).toBe(0);
    expect(summary.attempts.map((row) => row.attemptNumber)).toEqual([24, 21, 18]);
    expect(summary.attempts.every((row) => row.errorBody?.includes("503"))).toBe(true);
    expect((await delivery.deliver({ ...request, simulateFailure: false })).status).toBe("dlq");
    await service.retry(job!.id);
    await service.markRunning(job!.id, "late-worker");
    expect(await repo.listAttempts(job!.deliveryJobId)).toEqual(before);
  });

  test("uses account budgets, keeps successful delivery out, and isolates other accounts", async () => {
    const { service, delivery } = fixture(1);
    expect((await delivery.deliver({ ...request, simulateFailure: false })).status).toBe("completed");
    expect((await delivery.deliver({ ...request, briefId: "failed" })).status).toBe("dlq");
    expect((await delivery.deliver({ ...request, accountId: "legacy" })).status).toBe("failed");
    const [legacy] = await service.listByBrief("brief");
    expect(legacy).toBeDefined();
  });

  test("preserves canonical endpoint and history across legacy duplicates", async () => {
    const { repo, service } = fixture(2);
    const job = await service.ensureWebhookDispatchJob(request.accountId, request.briefId, request);
    const duplicate = await repo.create({ ...request, type: "dispatch_webhook",
      metadata: { ...request, endpointUrl: "https://wrong.example" } });
    for (let i = 0; i < 4; i++) await service.markFailed(duplicate.id, `body-${i}`);
    const processor = new DrainDlqProcessor(service);
    expect(processor.type).toBe("drain_dlq");
    expect((await processor.process(job.id)).status).toBe("dlq");
    const summary = (await service.dlqSummary(duplicate))!;
    expect(summary.endpointUrl).toBe(request.endpointUrl);
    expect(summary.pastBudgetCount).toBe(2);
    expect(summary.attempts.map((row) => [row.deliveryJobId, row.attemptNumber, row.errorBody]))
      .toEqual([[job.deliveryJobId, 4, "body-3"], [job.deliveryJobId, 3, "body-2"], [job.deliveryJobId, 2, "body-1"]]);
    expect(await service.displayStatus(duplicate)).toBe("dlq");
    const before = await repo.listAttempts(job.deliveryJobId);
    await processor.process(duplicate.id);
    expect(await repo.listAttempts(job.deliveryJobId)).toEqual(before);
  });

  test("honors pre-cutover retry count without inventing history and rollback wins", async () => {
    const { repo, service, delivery, rollbackAccounts } = fixture(2);
    const legacy = new JobRecordService(repo);
    const job = await legacy.ensureWebhookDispatchJob(request.accountId, request.briefId, request);
    await legacy.retry(job.id);
    await legacy.retry(job.id);
    await legacy.markFailed(job.id, "old error");
    expect(await repo.listAttempts(job.deliveryJobId)).toEqual([]);
    expect((await delivery.deliver(request)).status).toBe("dlq");
    expect((await repo.listAttempts(job.deliveryJobId)).map((row) => row.status)).toEqual(["dlq"]);
    rollbackAccounts.add(request.accountId);
    expect((await delivery.deliver({ ...request, simulateFailure: false })).status).toBe("completed");
    expect(await service.dlqSummary(job)).toBeNull();
    expect(await repo.listAttempts(job.deliveryJobId)).toHaveLength(1);
  });

  test("missing jobs fail and empty histories report no bodies", async () => {
    const { service } = fixture();
    await expect(new DrainDlqProcessor(service).process("missing")).rejects.toThrow("Job not found");
    const job = await service.ensureWebhookDispatchJob(request.accountId, request.briefId, request);
    expect((await service.dlqSummary(job))!.attempts).toEqual([]);
    expect((await service.drainDlq(job.id)).status).toBe("queued");
  });
});

test("HTTP delivery reaches DLQ and GET filters status while exposing canonical attempt bodies", async () => {
  const { service } = fixture(1);
  await service.ensureWebhookDispatchJob("another-account", request.briefId, request);
  const fetch = createHttpHandler(service);
  const delivered = await fetch(new Request("http://localhost/deliver", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  }));
  expect((await delivered.json() as { job: JobRecord }).job.status).toBe("dlq");
  const result = await fetch(new Request("http://localhost/briefs/brief/jobs?status=dlq"));
  const { jobs } = await result.json() as { jobs: (JobRecord & { dlq: DeliveryDlqSummary })[] };
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.dlq.endpointUrl).toBe(request.endpointUrl);
  expect(jobs[0]!.dlq.attempts).toHaveLength(1);
  expect(jobs[0]!.dlq.attempts.find((row) => row.status === "failed")!.errorBody).toContain("503");
  expect(jobs[0]!.dlq.attempts.every((row) => row.deliveryJobId === jobs[0]!.deliveryJobId)).toBe(true);
  const all = await fetch(new Request("http://localhost/briefs/brief/jobs"));
  expect((await all.json() as { jobs: JobRecord[] }).jobs).toHaveLength(1);
  const empty = await fetch(new Request("http://localhost/briefs/brief/jobs?status=failed"));
  expect(await empty.json()).toEqual({ jobs: [] });
});


test("cutover baseline plus a duplicate failure exhausts eight without double-counting retry", async () => {
  const { repo, service } = fixture();
  const legacy = new JobRecordService(repo);
  const job = await legacy.ensureWebhookDispatchJob(request.accountId, request.briefId, request);
  for (let index = 0; index < 7; index++) await legacy.retry(job.id);
  await legacy.markFailed(job.id, "pre-cutover");
  const duplicate = await repo.create({ ...request, type: "dispatch_webhook", metadata: request });
  await service.markRunning(duplicate.id, "worker");
  await service.retry(duplicate.id);
  await service.markFailed(duplicate.id, "eighth outcome");
  expect((await service.dlqSummary(job))!.failureCount).toBe(8);
  expect((await service.drainDlq(duplicate.id)).status).toBe("dlq");
  const history = await repo.listAttempts(job.deliveryJobId);
  expect(history.every((row) => row.legacyRetryCount === 7)).toBe(true);
  expect((await service.dlqSummary(job))!.attempts.map((row) => row.errorBody)).toEqual(["eighth outcome"]);
});

for (const interveningStatus of ["running", "completed"] as const) {
  test(`atomic DLQ precondition preserves intervening ${interveningStatus}`, async () => {
    class RacingRepository extends InMemoryJobRepository {
      override async execute(jobId: string, command: DeliveryExecutionCommand, appendAttempt: boolean) {
        if (command.kind === "drain_dlq") {
          await super.execute(jobId, { kind: "update", input: { status: interveningStatus } }, appendAttempt);
        }
        return super.execute(jobId, command, appendAttempt);
      }
    }
    const repo = new RacingRepository();
    const service = new JobRecordService(repo, new DeliveryAttemptRpc(repo, {
      pilotAccounts: new Set([request.accountId]), rollbackAccounts: new Set(),
    }), Date.now, new Map([[request.accountId, 1]]));
    const job = await service.ensureWebhookDispatchJob(request.accountId, request.briefId, request);
    await service.markFailed(job.id, "failed");
    expect((await service.drainDlq(job.id)).status).toBe(interveningStatus);
    expect((await repo.listAttempts(job.deliveryJobId)).map((row) => row.status))
      .toEqual(["failed", interveningStatus]);
    expect((await repo.findById(job.id))!.status).toBe(interveningStatus);
  });
}
