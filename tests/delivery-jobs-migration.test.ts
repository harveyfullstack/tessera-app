import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { DuplicateIntentError } from "../src/domain/errors";
import type { CreateJobInput, JobRecord } from "../src/domain/job";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import {
  assertAttemptCountParity,
  legacyAttemptCount,
  splitDeliverySchema,
} from "../src/infrastructure/migrations/split-delivery-schema";

const metadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function job(partial: Partial<JobRecord> & Pick<JobRecord, "id" | "status" | "retryCount">): JobRecord {
  const now = new Date("2026-08-13T00:00:00.000Z");
  return {
    accountId: "acct-1",
    briefId: "brief-1",
    type: "dispatch_webhook",
    metadata,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

const createInput: CreateJobInput = {
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook",
  metadata,
};

describe("delivery_jobs schema split", () => {
  test("migration SQL enforces uniqueness, latest-attempt index, and a non-cascade FK", () => {
    const sql = readFileSync(
      resolve(import.meta.dir, "../sql/migrations/002_delivery_jobs_and_attempts.sql"),
      "utf8",
    );

    expect(sql).toContain("ALTER TABLE jobs RENAME TO delivery_jobs");
    expect(sql).toContain("UNIQUE (account_id, brief_id, type)");
    expect(sql).toMatch(/delivery_job_id UUID NOT NULL REFERENCES delivery_jobs \(id\)/);
    expect(sql).not.toMatch(/REFERENCES delivery_jobs \(id\)\s+ON DELETE CASCADE/i);
    expect(sql).toContain("UNIQUE (delivery_job_id, attempt_number)");
    expect(sql).toContain("ON delivery_attempts (delivery_job_id, attempt_number DESC)");
    expect(sql).toContain("per-job attempt-count parity failed");
    expect(sql).toContain("aggregate attempt-count parity failed");
    expect(sql).toMatch(/attempt_number/);
    expect(sql).toMatch(/worker_id/);
    expect(sql).toMatch(/response_status/);
    expect(sql).toMatch(/response_latency_ms/);
    expect(sql).toMatch(/error_body/);
  });

  test("migrates every intent row without loss or duplication and proves attempt-count parity", () => {
    const jobs: JobRecord[] = [
      job({
        id: "dup-early",
        status: "failed",
        retryCount: 1,
        workerId: "worker-a",
        errorMessage: "timeout",
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
      }),
      job({
        id: "dup-late",
        status: "running",
        retryCount: 0,
        workerId: "worker-b",
        createdAt: new Date("2026-08-13T00:01:00.000Z"),
      }),
      job({
        id: "other",
        briefId: "brief-2",
        status: "queued",
        retryCount: 0,
        createdAt: new Date("2026-08-13T00:02:00.000Z"),
      }),
    ];

    const split = splitDeliverySchema(jobs);

    expect(split.deliveryJobs.map((row) => row.id).sort()).toEqual(["dup-early", "other"]);
    expect(split.remappedIds.get("dup-late")).toBe("dup-early");
    expect(split.attempts).toHaveLength(
      legacyAttemptCount(jobs[0]!) + legacyAttemptCount(jobs[1]!) + legacyAttemptCount(jobs[2]!),
    );

    const earlyAttempts = split.attempts.filter((attempt) => attempt.deliveryJobId === "dup-early");
    expect(earlyAttempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);

    expect(() => assertAttemptCountParity(jobs, split)).not.toThrow();
  });

  test("in-memory delivery_jobs reject duplicate (account_id, brief_id, type) and keep attempt numbers unique", async () => {
    const repo = new InMemoryJobRepository();
    const created = await repo.create(createInput);

    await expect(repo.create(createInput)).rejects.toBeInstanceOf(DuplicateIntentError);

    await repo.insertAttempt({
      deliveryJobId: created.id,
      attemptNumber: 1,
      status: "failed",
      workerId: "worker-us-east-04",
      responseStatus: 503,
      responseLatencyMs: 30_000,
      errorBody: "timeout",
    });

    await expect(
      repo.insertAttempt({
        deliveryJobId: created.id,
        attemptNumber: 1,
        status: "running",
      }),
    ).rejects.toThrow(/unique \(delivery_job_id, attempt_number\)/);

    const second = await repo.insertAttempt({
      deliveryJobId: created.id,
      attemptNumber: 2,
      status: "running",
      workerId: "worker-us-east-07",
    });

    const listed = await repo.listAttempts(created.id);
    expect(listed.map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
    expect(listed[0]?.id).toBe(second.id);
  });
});
