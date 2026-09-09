import { describe, expect, test } from "bun:test";
import { AccountRetryBudget } from "../src/application/account-retry-budget";
import { createHttpApp } from "../src/api/routes";

const deliverBody = {
  briefId: "brief-http-dlq",
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
  workerId: "worker-http",
  simulateFailure: true,
};

describe("GET /briefs/:briefId/jobs", () => {
  test("includes a dlq field and filters past-budget endpoints with ?status=dlq", async () => {
    const budgets = new AccountRetryBudget();
    budgets.set("tessera-demo-account", 2);
    const app = createHttpApp("tessera-demo-account", budgets);

    await app.fetch(
      new Request("http://tessera.test/deliver", {
        method: "POST",
        body: JSON.stringify(deliverBody),
      }),
    );
    await app.fetch(
      new Request("http://tessera.test/deliver", {
        method: "POST",
        body: JSON.stringify(deliverBody),
      }),
    );

    const all = await app.fetch(new Request("http://tessera.test/briefs/brief-http-dlq/jobs"));
    const allBody = (await all.json()) as {
      jobs: Array<{ type: string }>;
      dlq: { pastBudgetCount: number; endpoints: Array<{ endpointUrl: string; attemptBodies: string[] }> };
    };

    expect(allBody.dlq.pastBudgetCount).toBe(1);
    expect(allBody.dlq.endpoints[0]?.endpointUrl).toBe(deliverBody.endpointUrl);
    expect(allBody.dlq.endpoints[0]?.attemptBodies.length).toBeLessThanOrEqual(3);
    expect(allBody.jobs.some((job) => job.type === "dispatch_webhook")).toBe(true);
    expect(allBody.jobs.some((job) => job.type === "drain_dlq")).toBe(true);

    const filtered = await app.fetch(
      new Request("http://tessera.test/briefs/brief-http-dlq/jobs?status=dlq"),
    );
    const filteredBody = (await filtered.json()) as { jobs: Array<{ type: string }> };

    expect(filteredBody.jobs.every((job) => job.type === "dispatch_webhook")).toBe(true);
    expect(filteredBody.jobs).toHaveLength(1);
  });
});
