import { describe, expect, test } from "bun:test";
import { DlqService } from "../src/application/dlq-service";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "customer", subscriptionId: "subscription",
  endpointUrl: "https://example.com/hook", eventType: "event", payloadHash: "hash",
};

describe("DLQ processor", () => {
  test("moves past-budget endpoints once and exposes their last three attempt bodies", async () => {
    const repo = new InMemoryJobRepository();
    const records = new JobRecordService(repo);
    const dlq = new DlqService(repo, records, (account) => account === "account" ? 2 : 8);
    const job = await records.ensureWebhookDispatchJob("account", "brief", metadata);
    expect((await dlq.summary("account", "brief")).count).toBe(0);
    await records.markRunning(job.id, "worker");
    await records.markFailed(job.id, "first", { errorBody: "first body" });
    await records.retry(job.id);
    await records.markFailed(job.id, "second", { errorBody: "second body" });
    const summary = await dlq.summary("account", "brief");
    expect(summary.count).toBe(1);
    expect(summary.endpoints[0]?.attemptBodies).toEqual(["first body", "", "second body"]);
    expect(await dlq.drain("account", "brief", "worker")).toBe(1);
    expect(await dlq.drain("account", "brief", "worker")).toBe(0);
    expect((await repo.listDlq("brief"))[0]?.endpointUrl).toBe(metadata.endpointUrl);
    expect((await repo.findByBriefAndType("brief", "drain_dlq")).length).toBe(1);
  });

  test("uses the default budget of eight failures", async () => {
    const repo = new InMemoryJobRepository();
    const records = new JobRecordService(repo);
    const dlq = new DlqService(repo, records);
    const job = await records.ensureWebhookDispatchJob("account", "brief", metadata);
    for (let n = 0; n < 7; n++) await records.markFailed(job.id, `failure ${n}`);
    expect((await dlq.summary("account", "brief")).count).toBe(0);
    await records.markFailed(job.id, "failure 7");
    expect((await dlq.summary("account", "brief")).count).toBe(1);
  });
});
