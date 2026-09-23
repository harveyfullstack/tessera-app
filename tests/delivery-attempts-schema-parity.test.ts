import { describe, expect, test } from "bun:test";
import {
  DeliveryJobDeleteRestrictedError,
  DuplicateDeliveryAttemptError,
  DuplicateDeliveryJobError,
} from "../src/domain/errors";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

describe("Phase-2 delivery_jobs and delivery_attempts schema and parity", () => {
  const baseJobInput: CreateJobInput = {
    accountId: "acct-enterprise-99",
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

  test("enforces uniqueness on (account_id, brief_id, type) for delivery_jobs", async () => {
    const repo = new InMemoryJobRepository();

    const created = await repo.createDeliveryJob(baseJobInput);
    expect(created.id).toBeDefined();
    expect(created.accountId).toBe(baseJobInput.accountId);
    expect(created.briefId).toBe(baseJobInput.briefId);
    expect(created.type).toBe("dispatch_webhook");

    // Attempting to create duplicate delivery_job with same (account, brief, type) fails
    await expect(repo.createDeliveryJob(baseJobInput)).rejects.toThrow(
      DuplicateDeliveryJobError,
    );
  });

  test("enforces uniqueness on (delivery_job_id, attempt_number) for delivery_attempts", async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.createDeliveryJob(baseJobInput);

    const attempt1 = await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      workerId: "worker-us-east-01",
      status: "running",
    });
    expect(attempt1.attemptNumber).toBe(1);

    // Duplicate attempt number for same job throws DuplicateDeliveryAttemptError
    await expect(
      repo.createDeliveryAttempt({
        deliveryJobId: job.id,
        attemptNumber: 1,
        workerId: "worker-us-east-02",
        status: "failed",
      }),
    ).rejects.toThrow(DuplicateDeliveryAttemptError);

    // Sequential attempt number succeeds
    const attempt2 = await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 2,
      workerId: "worker-us-east-02",
      status: "completed",
      responseStatus: 200,
      responseLatencyMs: 142,
    });
    expect(attempt2.attemptNumber).toBe(2);
  });

  test("disallows CASCADE on FK: deleting delivery_jobs cannot take attempt history with it", async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.createDeliveryJob(baseJobInput);

    await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      workerId: "worker-us-east-01",
      status: "failed",
      errorBody: "connection refused",
    });

    // Attempting to delete delivery job with existing attempts throws DeliveryJobDeleteRestrictedError
    await expect(repo.deleteDeliveryJob(job.id)).rejects.toThrow(
      DeliveryJobDeleteRestrictedError,
    );

    // Job still exists
    const fetched = await repo.findDeliveryJobById(job.id);
    expect(fetched).not.toBeNull();
  });

  test("indexes (delivery_job_id, attempt_number DESC) for latest-attempt reads", async () => {
    const repo = new InMemoryJobRepository();
    const job = await repo.createDeliveryJob(baseJobInput);

    expect(await repo.getLatestDeliveryAttempt(job.id)).toBeNull();

    await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 1,
      workerId: "worker-01",
      status: "failed",
    });

    await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 2,
      workerId: "worker-02",
      status: "running",
    });

    await repo.createDeliveryAttempt({
      deliveryJobId: job.id,
      attemptNumber: 3,
      workerId: "worker-03",
      status: "completed",
      responseStatus: 200,
    });

    const latest = await repo.getLatestDeliveryAttempt(job.id);
    expect(latest).not.toBeNull();
    expect(latest?.attemptNumber).toBe(3);
    expect(latest?.status).toBe("completed");
    expect(latest?.workerId).toBe("worker-03");
  });

  test("migrates intent rows and proves old/new attempt-count parity per job and in aggregate", async () => {
    const repo = new InMemoryJobRepository();

    // 1. Queued job that never ran (0 attempts expected)
    await repo.create({
      accountId: "acct-1",
      briefId: "brief-queued-01",
      type: "dispatch_webhook",
      metadata: baseJobInput.metadata,
    });

    // 2. Job that ran once and succeeded (1 attempt expected)
    const completedJob = await repo.create({
      accountId: "acct-1",
      briefId: "brief-completed-01",
      type: "dispatch_webhook",
      metadata: baseJobInput.metadata,
    });
    await repo.updateExecution(completedJob.id, {
      status: "running",
      workerId: "worker-01",
    });
    await repo.updateExecution(completedJob.id, {
      status: "completed",
      workerId: "worker-01",
      details: { responseStatus: 200 },
    });

    // 3. Job that retried twice and failed (3 attempts expected: 2 retries + initial)
    const retriedJob = await repo.create({
      accountId: "acct-2",
      briefId: "brief-retried-01",
      type: "dispatch_webhook",
      metadata: baseJobInput.metadata,
    });
    await repo.updateExecution(retriedJob.id, {
      status: "running",
      workerId: "worker-02",
    });
    await repo.updateExecution(retriedJob.id, {
      status: "failed",
      errorMessage: "timeout 1",
    });
    await repo.incrementRetry(retriedJob.id);
    await repo.updateExecution(retriedJob.id, {
      status: "failed",
      errorMessage: "timeout 2",
    });
    await repo.incrementRetry(retriedJob.id);
    await repo.updateExecution(retriedJob.id, {
      status: "failed",
      errorMessage: "final 503",
    });

    // 4. Duplicate intent rows caused by retry race condition:
    // Two jobs created for the same (accountId, briefId, type)
    const racedJob1 = await repo.create({
      accountId: "acct-3",
      briefId: "brief-raced-01",
      type: "dispatch_webhook",
      metadata: baseJobInput.metadata,
    });
    await repo.updateExecution(racedJob1.id, {
      status: "failed",
      workerId: "worker-racer-1",
      errorMessage: "racer 1 failed",
    });

    const racedJob2 = await repo.create({
      accountId: "acct-3",
      briefId: "brief-raced-01",
      type: "dispatch_webhook",
      metadata: baseJobInput.metadata,
    });
    await repo.updateExecution(racedJob2.id, {
      status: "completed",
      workerId: "worker-racer-2",
    });

    // Pre-migration attempt counts:
    // Job 1 (queued): 0
    // Job 2 (completed): 1
    // Job 3 (retried 2 times): 3
    // Job 4+5 (raced): 1 + 1 = 2
    // Total aggregate old attempts: 0 + 1 + 3 + 2 = 6

    // Run migration
    const parity = await repo.migrateJobsToDeliverySchema();

    // Verify aggregate parity
    expect(parity.matches).toBe(true);
    expect(parity.totalOldAttempts).toBe(6);
    expect(parity.totalNewAttempts).toBe(6);

    // Verify per-job parity
    expect(parity.jobParities.length).toBe(4); // 4 unique delivery_jobs intents
    for (const jobParity of parity.jobParities) {
      expect(jobParity.matches).toBe(true);
      expect(jobParity.newAttemptCount).toBe(jobParity.oldAttemptCount);
    }

    // Verify that the raced intent was deduplicated to a single delivery_jobs row
    const racedDeliveryJob = await repo.findDeliveryJob(
      "acct-3",
      "brief-raced-01",
      "dispatch_webhook",
    );
    expect(racedDeliveryJob).not.toBeNull();
    const racedAttempts = await repo.listDeliveryAttempts(racedDeliveryJob!.id);
    expect(racedAttempts.length).toBe(2);
    expect(racedAttempts[0]!.attemptNumber).toBe(1);
    expect(racedAttempts[1]!.attemptNumber).toBe(2);

    // Run standalone verifyAttemptParity and ensure it also passes
    const standaloneParity = await repo.verifyAttemptParity();
    expect(standaloneParity.matches).toBe(true);
    expect(standaloneParity.totalOldAttempts).toBe(6);
    expect(standaloneParity.totalNewAttempts).toBe(6);

    const singleJobParity = await repo.verifyAttemptParity(racedDeliveryJob!.id);
    expect(singleJobParity.matches).toBe(true);
    expect(singleJobParity.totalOldAttempts).toBe(2);
    expect(singleJobParity.totalNewAttempts).toBe(2);
    expect(singleJobParity.jobParities.length).toBe(1);
  });
});
