import { describe, expect, test } from "bun:test";
import {
  assertAttemptCountParity,
  AttemptCountParityError,
  legacyAttemptCount,
  migrateDeliveryIntent,
} from "../src/application/delivery-attempt-parity";
import { DuplicateAttemptError, DuplicateIntentError } from "../src/domain/errors";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import type { JobMetadata, JobRecord } from "../src/domain/job";

const metadata: JobMetadata = {
  customerId: "cus_dana_fintech",
  subscriptionId: "sub_evt_pageview_anomaly",
  endpointUrl: "https://hooks.dana-fintech.com/tessera",
  eventType: "anomaly.detected",
  payloadHash: "sha256:7f3b1e",
};

function job(overrides: Partial<JobRecord>): JobRecord {
  const now = new Date("2026-08-21T23:33:34.625Z");
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

describe("delivery_attempts schema split", () => {
  test("never-started queued jobs contribute zero attempts", () => {
    expect(legacyAttemptCount(job({}))).toBe(0);
  });

  test("migrates every intent row without loss or duplication and preserves attempt-count parity", () => {
    const canonical = job({
      id: "job-canonical",
      status: "failed",
      retryCount: 2,
      workerId: "worker-us-east-04",
      errorMessage: "endpoint timeout after 30s",
      startedAt: new Date("2026-08-21T23:40:00.000Z"),
      completedAt: new Date("2026-08-21T23:40:30.000Z"),
    });
    const duplicate = job({
      id: "job-duplicate",
      status: "running",
      retryCount: 1,
      workerId: "worker-us-east-07",
      startedAt: new Date("2026-08-21T23:41:00.000Z"),
      createdAt: new Date("2026-08-21T23:34:00.000Z"),
    });
    const other = job({
      id: "job-other",
      briefId: "brief-other",
      status: "completed",
      retryCount: 0,
      startedAt: new Date("2026-08-21T23:39:00.000Z"),
      completedAt: new Date("2026-08-21T23:39:02.000Z"),
    });
    const queued = job({
      id: "job-queued",
      briefId: "brief-queued",
    });

    const jobs = [canonical, duplicate, other, queued];
    const { deliveryJobs, attempts } = migrateDeliveryIntent(jobs);

    expect(deliveryJobs.map((row) => row.id).sort()).toEqual(
      ["job-canonical", "job-other", "job-queued"].sort(),
    );
    expect(attempts.filter((attempt) => attempt.deliveryJobId === "job-canonical")).toHaveLength(
      legacyAttemptCount(canonical) + legacyAttemptCount(duplicate),
    );
    expect(attempts.filter((attempt) => attempt.deliveryJobId === "job-other")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.deliveryJobId === "job-queued")).toHaveLength(0);

    expect(() => assertAttemptCountParity(jobs, attempts)).not.toThrow();
  });

  test("rejects aggregate attempt-count drift before cutover", () => {
    const running = job({
      id: "job-running",
      status: "running",
      retryCount: 2,
      startedAt: new Date(),
    });
    const { attempts } = migrateDeliveryIntent([running]);

    expect(() => assertAttemptCountParity([running], attempts.slice(0, 1))).toThrow(
      AttemptCountParityError,
    );
  });

  test("enforces uniqueness on (account_id, brief_id, type)", async () => {
    const repo = new InMemoryJobRepository();
    const input = {
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook" as const,
      metadata,
    };

    await repo.create(input);
    await expect(repo.create(input)).rejects.toBeInstanceOf(DuplicateIntentError);
  });

  test("enforces uniqueness on (delivery_job_id, attempt_number) and refuses cascading deletes", async () => {
    const repo = new InMemoryJobRepository();
    const created = await repo.create({
      accountId: "acct-1",
      briefId: "brief-1",
      type: "dispatch_webhook",
      metadata,
    });

    await repo.insertAttempt({
      deliveryJobId: created.id,
      attemptNumber: 1,
      status: "failed",
      errorBody: "endpoint returned 503 after 30s timeout",
    });

    await expect(
      repo.insertAttempt({
        deliveryJobId: created.id,
        attemptNumber: 1,
        status: "running",
      }),
    ).rejects.toBeInstanceOf(DuplicateAttemptError);

    await expect(repo.deleteJob(created.id)).rejects.toThrow(/delivery_attempts history exists/);
    expect(await repo.listAttempts(created.id)).toHaveLength(1);
  });

  test("migration SQL adds the required constraints and does not cascade attempt deletes", async () => {
    const sql = await Bun.file("sql/migrations/002_split_delivery_intent.sql").text();
    const canonical = await Bun.file("sql/schema.sql").text();

    expect(sql).toContain("ALTER TABLE jobs RENAME TO delivery_jobs");
    expect(sql).toContain("UNIQUE (account_id, brief_id, type)");
    expect(sql).toContain("UNIQUE (delivery_job_id, attempt_number)");
    expect(sql).toContain("delivery_attempts (delivery_job_id, attempt_number DESC)");
    expect(sql).toMatch(/delivery_job_id UUID NOT NULL REFERENCES delivery_jobs\(id\),/);
    expect(sql).not.toMatch(/REFERENCES delivery_jobs\(id\)\s+ON DELETE/i);
    expect(sql).toContain("delivery attempt-count parity failed");

    expect(canonical).toContain("CONSTRAINT delivery_jobs_account_brief_type_key UNIQUE (account_id, brief_id, type)");
    expect(canonical).toContain("CONSTRAINT delivery_attempts_job_attempt_key UNIQUE (delivery_job_id, attempt_number)");
    expect(canonical).toMatch(/delivery_job_id UUID NOT NULL REFERENCES delivery_jobs\(id\),/);
    expect(canonical).not.toMatch(/REFERENCES delivery_jobs\(id\)\s+ON DELETE/i);
  });
});
