import { describe, expect, test } from "bun:test";
import { createDeliveryAppContext } from "../src/application/delivery-app-context";

describe("GET /briefs/:briefId/jobs listing contract", () => {
  test("includes a dlq summary and supports status=dlq filtering", async () => {
    const { jobRecords, drainDlq, retryBudgets } = createDeliveryAppContext();
    retryBudgets.setRetryBudget("acct-1", 2);

    const job = await jobRecords.ensureWebhookDispatchJob("acct-1", "brief-http", {
      customerId: "cus_dana_fintech",
      subscriptionId: "sub_evt_pageview_anomaly",
      endpointUrl: "https://hooks.dana-fintech.com/tessera",
      eventType: "anomaly.detected",
      payloadHash: "sha256:7f3b1e",
    });

    await jobRecords.markRunning(job.id, "worker-1");
    await jobRecords.markFailed(job.id, "first", { errorBody: "body-1" });
    await jobRecords.retry(job.id);
    await jobRecords.markRunning(job.id, "worker-2");
    await jobRecords.markFailed(job.id, "second", { errorBody: "body-2" });

    const rows = await jobRecords.listByBrief("brief-http");
    const filtered = [];
    for (const row of rows) {
      if ((await jobRecords.displayStatus(row)) === "dlq") {
        filtered.push(row);
      }
    }

    const dlq = await drainDlq.buildDlqSummary("brief-http", "acct-1");
    expect(filtered).toHaveLength(1);
    expect(dlq.pastBudgetCount).toBe(1);
    expect(dlq.endpoints[0]?.lastAttemptBodies.slice(0, 3)).toEqual(["body-2", "body-1"]);
  });
});
