import { describe, expect, test } from "bun:test";
import { AccountRetryBudgetRegistry } from "../src/application/account-retry-budget";
import { createApp, createAppDependencies } from "../src/api/app";
import type { CreateJobInput } from "../src/domain/job";

const input: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-http",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

describe("GET /briefs/:briefId/jobs", () => {
  test("includes a dlq field and supports ?status=dlq", async () => {
    const budgets = new AccountRetryBudgetRegistry();
    budgets.set(input.accountId, 3);
    const deps = createAppDependencies(input.accountId, budgets);
    const app = createApp(deps);
    const job = await deps.jobRecords.ensureJobRecord(input);

    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      await deps.jobRecords.markFailed(job.id, `body-${attemptNumber}`, {
        errorBody: `body-${attemptNumber}`,
      });
    }

    await deps.drainDlq.process(input.briefId, input.accountId);

    const all = await app.fetch(new Request("http://tessera.test/briefs/brief-http/jobs"));
    const allBody = (await all.json()) as {
      jobs: Array<{ id: string; displayStatus: string }>;
      dlq: {
        pastBudgetCount: number;
        endpoints: Array<{ endpointUrl: string; lastThreeAttemptBodies: string[] }>;
      };
    };

    expect(allBody.dlq.pastBudgetCount).toBe(1);
    expect(allBody.dlq.endpoints).toEqual([
      {
        endpointUrl: input.metadata.endpointUrl,
        lastThreeAttemptBodies: ["body-3", "body-2", "body-1"],
      },
    ]);

    const filtered = await app.fetch(
      new Request("http://tessera.test/briefs/brief-http/jobs?status=dlq"),
    );
    const filteredBody = (await filtered.json()) as { jobs: Array<{ displayStatus: string }> };
    expect(filteredBody.jobs.every((row) => row.displayStatus === "dlq")).toBe(true);
    expect(filteredBody.jobs).toHaveLength(1);
  });
});
