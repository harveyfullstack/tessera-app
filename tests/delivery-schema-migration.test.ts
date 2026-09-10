import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  legacyAttemptCount,
  migrateJobsToDeliverySchema,
  proveAttemptCountParity,
} from "../src/application/delivery-schema-migration";
import { DuplicateDeliveryJobError } from "../src/domain/errors";
import type { JobRecord } from "../src/domain/job";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function job(overrides: Partial<JobRecord> & Pick<JobRecord, "id">): JobRecord {
  const now = new Date("2026-08-13T05:04:44.820Z");
  return {
    accountId: "acct-1",
    briefId: "brief-1",
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
  test("migration SQL forbids CASCADE and unique-indexes intent plus attempts", () => {
    const sql = readFileSync(
      resolve(import.meta.dir, "../sql/migrations/002_delivery_jobs_and_attempts.sql"),
      "utf8",
    );

    expect(sql).toContain("ALTER TABLE IF EXISTS jobs RENAME TO delivery_jobs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS delivery_attempts");
    expect(sql).toContain("REFERENCES delivery_jobs(id)");
    expect(sql).not.toMatch(/ON DELETE\s+CASCADE/i);
    expect(sql).toContain("UNIQUE (delivery_job_id, attempt_number)");
    expect(sql).toContain("delivery_jobs_account_brief_type_uidx");
    expect(sql).toContain("(delivery_job_id, attempt_number DESC)");
    expect(sql).toContain("attempt-count parity failed");
  });

  test("migrates every intent row without loss or duplication and proves attempt-count parity", () => {
    const queued = job({ id: "job-queued" });
    const completed = job({
      id: "job-completed",
      briefId: "brief-2",
      status: "completed",
      retryCount: 0,
      workerId: "worker-a",
      startedAt: new Date("2026-08-13T05:05:00.000Z"),
      completedAt: new Date("2026-08-13T05:05:01.000Z"),
    });
    const retried = job({
      id: "job-retried",
      briefId: "brief-3",
      status: "failed",
      retryCount: 2,
      workerId: "worker-b",
      errorMessage: "timeout",
      startedAt: new Date("2026-08-13T05:06:00.000Z"),
    });
    const duplicateIntent = job({
      id: "job-dup",
      briefId: "brief-2",
      status: "failed",
      retryCount: 0,
      workerId: "worker-race",
      errorMessage: "lost race",
      startedAt: new Date("2026-08-13T05:05:30.000Z"),
      createdAt: new Date("2026-08-13T05:05:30.000Z"),
      updatedAt: new Date("2026-08-13T05:05:31.000Z"),
    });

    const legacy = [queued, completed, retried, duplicateIntent];
    const result = migrateJobsToDeliverySchema(legacy);

    expect(result.deliveryJobs).toHaveLength(3);
    expect(result.deliveryJobs.map((row) => row.id).sort()).toEqual([
      "job-completed",
      "job-queued",
      "job-retried",
    ]);
    expect(result.attempts.filter((attempt) => attempt.deliveryJobId === "job-queued")).toHaveLength(
      0,
    );
    expect(
      result.attempts.filter((attempt) => attempt.deliveryJobId === "job-completed"),
    ).toHaveLength(legacyAttemptCount(completed) + legacyAttemptCount(duplicateIntent));
    expect(result.attempts.filter((attempt) => attempt.deliveryJobId === "job-retried")).toHaveLength(
      3,
    );
    expect(result.parity.matched).toBe(true);
    expect(result.parity.oldAggregate).toBe(result.parity.newAggregate);
    expect(
      proveAttemptCountParity(legacy, result.deliveryJobs, result.attempts).matched,
    ).toBe(true);
  });

  test("in-memory store enforces intent uniqueness and retains attempts after job delete", async () => {
    const repo = new InMemoryJobRepository();
    const first = await repo.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await expect(
      repo.create({
        accountId: "acct-1",
        briefId: "brief-1",
        type: "dispatch_webhook",
        metadata,
      }),
    ).rejects.toBeInstanceOf(DuplicateDeliveryJobError);

    await repo.insertAttempt({
      deliveryJobId: first.id,
      status: "failed",
      attemptNumber: 1,
      errorBody: "timeout",
    });
    await repo.deleteDeliveryJob(first.id);

    expect(await repo.findById(first.id)).toBeNull();
    const leftover = await repo.listAttempts(first.id);
    expect(leftover).toHaveLength(1);
    expect(leftover[0]?.errorBody).toBe("timeout");
  });
});
