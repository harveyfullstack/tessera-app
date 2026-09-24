import { describe, expect, test } from "bun:test";
import { migrateDeliverySchema, proveAttemptCountParity } from "../src/application/migrate-delivery-schema";
import { DeliverySchemaMigrationError } from "../src/domain/errors";
import type { DeliveryAttempt, DeliveryJobSource } from "../src/domain/delivery-schema";
import type { JobMetadata, JobRecord } from "../src/domain/job";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function legacyJob(overrides: Partial<JobRecord> & Pick<JobRecord, "id">): JobRecord {
  return {
    accountId: "acct-1",
    briefId: "brief-1",
    type: "dispatch_webhook",
    metadata: { ...metadata },
    status: "queued",
    retryCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("migrateDeliverySchema", () => {
  test("keeps a never-started job as intent with zero attempts", () => {
    const result = migrateDeliverySchema([legacyJob({ id: "job-queued" })]);

    expect(result.deliveryJobs.map((job) => job.id)).toEqual(["job-queued"]);
    expect(result.attempts).toEqual([]);
    expect(result.sources).toEqual([
      { legacyJobId: "job-queued", deliveryJobId: "job-queued", isCanonical: true },
    ]);
    expect(result.aggregate).toEqual({ legacyAttemptCount: 0, deliveryAttemptCount: 0 });
  });

  test("rebuilds overwritten attempts and proves per-job and aggregate parity", () => {
    const older = legacyJob({
      id: "job-older",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      status: "failed",
      retryCount: 1,
      errorMessage: "timeout",
      workerId: "worker-a",
    });
    const newer = legacyJob({
      id: "job-newer",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      status: "completed",
      retryCount: 2,
      workerId: "worker-b",
      startedAt: new Date("2026-01-02T00:01:00Z"),
    });
    const other = legacyJob({
      id: "job-other",
      briefId: "brief-2",
      status: "running",
      retryCount: 0,
      workerId: "worker-c",
      startedAt: new Date("2026-01-03T00:00:00Z"),
    });

    const result = migrateDeliverySchema([newer, other, older]);
    const canonical = result.deliveryJobs.find((job) => job.briefId === "brief-1");
    const attempts = result.attempts.filter((attempt) => attempt.deliveryJobId === canonical?.id);

    expect(result.deliveryJobs).toHaveLength(2);
    expect(canonical?.id).toBe("job-older");
    expect(result.sources).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4]);
    expect(attempts[0]).toMatchObject({ status: "failed", errorBody: "timeout", workerId: "worker-a" });
    expect(attempts[1]).toMatchObject({ status: "failed" });
    expect(attempts[1]?.workerId).toBeUndefined();
    expect(attempts[1]?.errorBody).toBeUndefined();
    expect(attempts[3]).toMatchObject({ status: "completed", workerId: "worker-b" });
    expect(result.parityByJob.every((row) => row.legacyAttemptCount === row.deliveryAttemptCount)).toBe(true);
    expect(result.aggregate).toEqual({ legacyAttemptCount: 5, deliveryAttemptCount: 5 });
  });

  test("remaps parent links onto the canonical delivery job", () => {
    const parent = legacyJob({
      id: "parent-dup",
      type: "drain_dlq",
      createdAt: new Date("2026-02-02T00:00:00Z"),
    });
    const canonicalParent = legacyJob({
      id: "parent-canonical",
      type: "drain_dlq",
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    const child = legacyJob({
      id: "child",
      parentJobId: "parent-dup",
      createdAt: new Date("2026-02-03T00:00:00Z"),
    });

    const result = migrateDeliverySchema([child, parent, canonicalParent]);
    const deliveryChild = result.deliveryJobs.find((job) => job.id === "child");

    expect(deliveryChild?.parentJobId).toBe("parent-canonical");
  });

  test("refuses duplicate intent rows that disagree", () => {
    const original = legacyJob({ id: "job-a" });
    const drifted = legacyJob({
      id: "job-b",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      metadata: { ...metadata, endpointUrl: "https://hooks.example.test/other" },
    });

    expect(() => migrateDeliverySchema([original, drifted])).toThrow(DeliverySchemaMigrationError);
  });

  test("refuses an orphan parent and a negative retry count", () => {
    expect(() => migrateDeliverySchema([legacyJob({ id: "child", parentJobId: "missing" })])).toThrow(
      /orphan parent_job_id/,
    );
    expect(() => migrateDeliverySchema([legacyJob({ id: "bad-retry", retryCount: -1 })])).toThrow(
      /retryCount must be a non-negative integer/,
    );
  });

  test("reports parity failure without dropping the compared rows", () => {
    const jobs = [legacyJob({ id: "job-1", status: "completed", retryCount: 0, startedAt: new Date() })];
    const sources: DeliveryJobSource[] = [
      { legacyJobId: "job-1", deliveryJobId: "job-1", isCanonical: true },
    ];
    const attempts: DeliveryAttempt[] = [];

    const proof = proveAttemptCountParity(jobs, sources, attempts);

    expect(proof.ok).toBe(false);
    expect(proof.byJob).toEqual([
      { deliveryJobId: "job-1", legacyAttemptCount: 1, deliveryAttemptCount: 0 },
    ]);
    expect(proof.aggregate.deliveryAttemptCount).toBe(0);
  });
});
