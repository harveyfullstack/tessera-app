import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  assertAttemptCountParity,
  legacyAttemptCount,
  migrateJobsToDeliverySchema,
} from "../src/application/delivery-schema-migration";
import type { JobMetadata, JobRecord } from "../src/domain/job";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function job(overrides: Partial<JobRecord>): JobRecord {
  const now = new Date("2026-08-13T04:14:44.821Z");
  return {
    id: overrides.id ?? crypto.randomUUID(),
    accountId: "acct-1",
    briefId: "50ce0002-0000-4000-a001-000000000001",
    type: "dispatch_webhook",
    metadata,
    status: "queued",
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("delivery schema migration", () => {
  test("renames each unique intent onto one delivery_job without dropping rows", () => {
    const queued = job({ id: "job-queued" });
    const otherBrief = job({
      id: "job-other-brief",
      briefId: "50ce0002-0000-4000-a001-000000000002",
      status: "completed",
      startedAt: new Date("2026-08-13T04:20:00.000Z"),
      completedAt: new Date("2026-08-13T04:20:01.000Z"),
    });

    const result = migrateJobsToDeliverySchema([queued, otherBrief]);

    expect(result.deliveryJobs.map((row) => row.id).sort()).toEqual(["job-other-brief", "job-queued"]);
    expect(result.deliveryJobs.every((row) => row.metadata.payloadHash === metadata.payloadHash)).toBe(true);
    expect(result.deliveryAttempts.filter((row) => row.deliveryJobId === "job-queued")).toHaveLength(0);
    expect(result.deliveryAttempts.filter((row) => row.deliveryJobId === "job-other-brief")).toHaveLength(1);
  });

  test("collapses duplicate (account_id, brief_id, type) rows onto the earliest intent", () => {
    const first = job({
      id: "job-first",
      createdAt: new Date("2026-08-13T04:14:44.821Z"),
      status: "failed",
      retryCount: 1,
      workerId: "worker-us-east-04",
      errorMessage: "endpoint timeout after 30s",
      startedAt: new Date("2026-08-13T04:15:00.000Z"),
    });
    const raced = job({
      id: "job-raced",
      createdAt: new Date("2026-08-13T04:14:45.821Z"),
      status: "completed",
      workerId: "worker-us-east-07",
      startedAt: new Date("2026-08-13T04:16:00.000Z"),
      completedAt: new Date("2026-08-13T04:16:01.000Z"),
    });

    const result = migrateJobsToDeliverySchema([raced, first]);

    expect(result.deliveryJobs).toHaveLength(1);
    expect(result.deliveryJobs[0]?.id).toBe("job-first");
    expect(result.deliveryAttempts.every((row) => row.deliveryJobId === "job-first")).toBe(true);
    expect(result.deliveryAttempts.map((row) => row.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(result.deliveryAttempts.map((row) => `${row.deliveryJobId}:${row.attemptNumber}`)).size).toBe(3);
  });

  test("proves old/new attempt-count parity per delivery job and in aggregate", () => {
    const rows = [
      job({ id: "untouched" }),
      job({
        id: "running",
        briefId: "brief-running",
        status: "running",
        retryCount: 1,
        workerId: "worker-us-east-04",
        startedAt: new Date("2026-08-13T04:18:00.000Z"),
      }),
      job({
        id: "failed",
        briefId: "brief-failed",
        status: "failed",
        retryCount: 2,
        errorMessage: "endpoint returned 503 after 30s timeout",
        startedAt: new Date("2026-08-13T04:19:00.000Z"),
      }),
    ];

    const result = migrateJobsToDeliverySchema(rows);

    expect(legacyAttemptCount(rows[0]!)).toBe(0);
    expect(legacyAttemptCount(rows[1]!)).toBe(2);
    expect(legacyAttemptCount(rows[2]!)).toBe(3);
    expect(result.perJobParity.every((row) => row.matches)).toBe(true);
    expect(result.aggregateParity).toEqual({
      oldAttemptCount: 5,
      newAttemptCount: 5,
      matches: true,
    });
    expect(() => assertAttemptCountParity(result)).not.toThrow();
  });

  test("copied attempts keep worker, status, and error body from the source row", () => {
    const failed = job({
      id: "job-failed",
      status: "failed",
      retryCount: 0,
      workerId: "worker-us-east-04",
      errorMessage: "endpoint timeout after 30s",
      startedAt: new Date("2026-08-13T04:15:00.000Z"),
    });

    const result = migrateJobsToDeliverySchema([failed]);
    const attempt = result.deliveryAttempts[0];

    expect(attempt).toMatchObject({
      deliveryJobId: "job-failed",
      attemptNumber: 1,
      workerId: "worker-us-east-04",
      status: "failed",
      errorBody: "endpoint timeout after 30s",
    });
  });
});

describe("phase-2 SQL migration", () => {
  const sql = readFileSync(resolve(import.meta.dir, "../sql/migrations/002_delivery_jobs_and_attempts.sql"), "utf8");

  test("renames jobs to delivery_jobs and unique-constrains intent identity", () => {
    expect(sql).toContain("ALTER TABLE jobs RENAME TO delivery_jobs");
    expect(sql).toMatch(/UNIQUE\s*\(\s*account_id\s*,\s*brief_id\s*,\s*type\s*\)/);
  });

  test("adds append-only delivery_attempts with the required columns and indexes", () => {
    expect(sql).toContain("CREATE TABLE delivery_attempts");
    for (const column of [
      "delivery_job_id",
      "attempt_number",
      "worker_id",
      "status",
      "response_status",
      "response_latency_ms",
      "error_body",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]*\(delivery_job_id, attempt_number\)/);
    expect(sql).toMatch(/ON delivery_attempts \(delivery_job_id, attempt_number DESC\)/);
  });

  test("does not cascade deletes from delivery_jobs onto attempt history", () => {
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).toMatch(/REFERENCES delivery_jobs\(id\) ON DELETE RESTRICT/);
  });

  test("proves attempt-count parity before cutover commits", () => {
    expect(sql).toContain("aggregate attempt-count parity failed");
    expect(sql).toContain("per-job attempt-count parity failed");
  });
});
