import { describe, expect, test } from "bun:test";
import {
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
  JobNotFoundError,
} from "../src/domain/errors";
import { InMemoryDeliveryJobRepository } from "../src/infrastructure/repositories/in-memory-delivery-job-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
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

const migration = await Bun.file(
  new URL("../sql/migrations/002_delivery_jobs_and_attempts.sql", import.meta.url),
).text();

describe("delivery_jobs / delivery_attempts schema", () => {
  test("delivery_jobs is unique on (account_id, brief_id, type)", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS delivery_jobs");
    expect(migration).toContain("UNIQUE (account_id, brief_id, type)");
  });

  test("delivery_attempts is unique on (delivery_job_id, attempt_number)", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS delivery_attempts");
    expect(migration).toContain("UNIQUE (delivery_job_id, attempt_number)");
  });

  test("latest-attempt index is (delivery_job_id, attempt_number DESC)", () => {
    expect(migration).toMatch(/ON delivery_attempts \(delivery_job_id, attempt_number DESC\)/);
  });

  test("FK from delivery_attempts to delivery_jobs has no ON DELETE CASCADE", () => {
    expect(migration).toMatch(/delivery_job_id UUID NOT NULL REFERENCES delivery_jobs\(id\)/);
    expect(migration).not.toMatch(/ON DELETE CASCADE/);
  });
});

describe("InMemoryDeliveryJobRepository", () => {
  test("rejects a second intent row for the same account, brief, and type", async () => {
    const repo = new InMemoryDeliveryJobRepository();

    await repo.create(baseInput);

    await expect(repo.create(baseInput)).rejects.toBeInstanceOf(DuplicateDeliveryJobError);
  });

  test("allows a second intent row when type differs", async () => {
    const repo = new InMemoryDeliveryJobRepository();

    const webhook = await repo.create(baseInput);
    const drain = await repo.create({ ...baseInput, type: "drain_dlq" });

    expect(drain.id).not.toBe(webhook.id);
    expect(await repo.findByAccountBriefAndType("acct-1", baseInput.briefId, "drain_dlq")).toEqual(
      drain,
    );
  });

  test("returns null when intent or id is missing", async () => {
    const repo = new InMemoryDeliveryJobRepository();

    expect(await repo.findById("missing")).toBeNull();
    expect(
      await repo.findByAccountBriefAndType("acct-1", baseInput.briefId, "dispatch_webhook"),
    ).toBeNull();
    expect(await repo.listAttempts("missing")).toEqual([]);
  });

  test("appends attempts and lists the latest first", async () => {
    const repo = new InMemoryDeliveryJobRepository();
    const job = await repo.create(baseInput);

    await repo.appendAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      workerId: "worker-us-east-04",
      status: "failed",
      responseStatus: 503,
      errorBody: "endpoint timeout after 30s",
    });
    const second = await repo.appendAttempt({
      deliveryJobId: job.id,
      attemptNumber: 2,
      workerId: "worker-us-east-07",
      status: "completed",
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    const history = await repo.listAttempts(job.id);

    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([2, 1]);
    expect(history[0]?.id).toBe(second.id);
    expect(history[1]?.errorBody).toBe("endpoint timeout after 30s");
  });

  test("rejects a duplicate attempt number for the same delivery job", async () => {
    const repo = new InMemoryDeliveryJobRepository();
    const job = await repo.create(baseInput);
    const input = {
      deliveryJobId: job.id,
      attemptNumber: 1,
      status: "running" as const,
      workerId: "worker-us-east-04",
    };

    await repo.appendAttempt(input);

    await expect(repo.appendAttempt(input)).rejects.toBeInstanceOf(DuplicateDeliveryAttemptError);
  });

  test("rejects an attempt when the delivery job does not exist", async () => {
    const repo = new InMemoryDeliveryJobRepository();

    await expect(
      repo.appendAttempt({
        deliveryJobId: "missing-job",
        attemptNumber: 1,
        status: "running",
      }),
    ).rejects.toBeInstanceOf(JobNotFoundError);
  });
});

describe("jobs table coexistence", () => {
  test("existing jobs writes still accept duplicate intent rows", async () => {
    const jobs = new InMemoryJobRepository();

    await jobs.create(baseInput);
    await jobs.create(baseInput);

    const found = await jobs.findByBriefAndType(baseInput.briefId, baseInput.type);
    expect(found).toHaveLength(2);
  });
});
