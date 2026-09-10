import { describe, expect, test } from "bun:test";
import { createJobServiceGraph } from "../src/application/job-service-factory";
import { InMemoryDeliverySplitFlags } from "../src/application/delivery-split-flags";
import { STUCK_ATTEMPT_AFTER_MS } from "../src/application/job-record-service";
import type { CreateJobInput } from "../src/domain/job";

const baseInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "50ce0002-0000-4000-a001-000000000001",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus_dana_fintech",
    subscriptionId: "sub_evt_pageview_anomaly",
    endpointUrl: "https://hooks.dana-fintech.com/tessera",
    eventType: "anomaly.detected",
    payloadHash: "sha256:7f3b1e",
  },
};

describe("JobRecordService.displayStatus", () => {
  test("returns queued when the job has no attempts", async () => {
    const { jobRecords } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);

    expect(await jobRecords.displayStatus(job)).toBe("queued");
  });

  test("returns the latest attempt status from MAX(attempt_number)", async () => {
    const { jobRecords } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);

    await jobRecords.markRunning(job.id, "worker-us-east-04");
    await jobRecords.markFailed(job.id, "endpoint timeout after 30s");

    expect(await jobRecords.displayStatus(job)).toBe("failed");
  });

  test("returns stuck when the latest running attempt started more than 5 minutes ago", async () => {
    const { jobRecords, attempts } = createJobServiceGraph();
    const job = await jobRecords.ensureJobRecord(baseInput);
    const startedAt = new Date("2026-08-13T04:00:00.000Z");

    await attempts.append(job.id, {
      status: "running",
      workerId: "worker-us-east-04",
      startedAt,
    });

    expect(await jobRecords.displayStatus(job, new Date(startedAt.getTime() + STUCK_ATTEMPT_AFTER_MS))).toBe(
      "running",
    );
    expect(
      await jobRecords.displayStatus(job, new Date(startedAt.getTime() + STUCK_ATTEMPT_AFTER_MS + 1)),
    ).toBe("stuck");
  });

  test("falls back to jobs.status when the rollback feature flag is on", async () => {
    const flags = new InMemoryDeliverySplitFlags();
    const { jobRecords, attempts } = createJobServiceGraph({ flags });
    const job = await jobRecords.ensureJobRecord(baseInput);

    await attempts.append(job.id, {
      status: "failed",
      errorBody: "endpoint timeout after 30s",
      startedAt: new Date("2026-08-13T04:00:00.000Z"),
    });
    flags.enableRollback(job.accountId);

    expect(job.status).toBe("queued");
    expect(await jobRecords.displayStatus(job)).toBe("queued");
  });
});
