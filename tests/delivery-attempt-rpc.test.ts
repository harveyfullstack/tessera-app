import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobNotFoundError, NoRunningAttemptError } from "../src/domain/errors";
import type { CreateJobInput } from "../src/domain/job";
import { InMemoryDeliveryRollbackFlag } from "../src/infrastructure/flags/in-memory-delivery-rollback-flag";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

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

function setup(rolledBackAccountIds: string[] = []) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(
    jobs,
    attempts,
    new InMemoryDeliveryRollbackFlag(rolledBackAccountIds),
  );
  return { jobs, attempts, rpc };
}

describe("DeliveryAttemptRpc", () => {
  test("gives concurrent markRunning callers unique, monotonically increasing attempt numbers", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await jobs.create(baseInput);
    const workers = ["w-1", "w-2", "w-3", "w-4", "w-5"];

    await Promise.all(workers.map((workerId) => rpc.markRunning(job.id, workerId)));

    const history = await attempts.listByJob(job.id);
    expect(history.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(history.map((attempt) => attempt.workerId))).toEqual(new Set(workers));
    expect(history.every((attempt) => attempt.status === "running")).toBe(true);
  });

  test("writes one attempt row per execution and finishes it exactly once", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await jobs.create(baseInput);

    await rpc.markRunning(job.id, "worker-us-east-04");
    await rpc.markFailed(job.id, "endpoint timeout after 30s", {
      responseStatus: 504,
      responseLatencyMs: 30_000,
    });
    await rpc.retry(job.id);
    expect(await attempts.listByJob(job.id)).toHaveLength(1);

    await rpc.markRunning(job.id, "worker-us-east-07");
    const final = await rpc.markCompleted(job.id, {
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    const [first, second] = await attempts.listByJob(job.id);
    expect(first).toMatchObject({
      attemptNumber: 1,
      status: "failed",
      workerId: "worker-us-east-04",
      responseStatus: 504,
      responseLatencyMs: 30_000,
      errorBody: "endpoint timeout after 30s",
    });
    expect(first?.completedAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({
      attemptNumber: 2,
      status: "completed",
      workerId: "worker-us-east-07",
      responseStatus: 200,
      responseLatencyMs: 187,
    });
    expect(second?.completedAt).toBeInstanceOf(Date);

    expect(final).toMatchObject({ id: job.id, status: "completed", retryCount: 1 });
    expect(await jobs.findById(job.id)).toEqual(job);
  });

  test("prefers the response body over the error message for error_body", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await jobs.create(baseInput);

    await rpc.markRunning(job.id, "worker-us-east-04");
    await rpc.markFailed(job.id, "Simulated webhook delivery failure", {
      responseStatus: 503,
      errorBody: "endpoint returned 503 after 30s timeout",
    });

    const [attempt] = await attempts.listByJob(job.id);
    expect(attempt?.errorBody).toBe("endpoint returned 503 after 30s timeout");
  });

  test("rejects finishing an execution that has no running attempt", async () => {
    const { jobs, rpc } = setup();
    const job = await jobs.create(baseInput);

    await expect(rpc.markCompleted(job.id, { responseStatus: 200 })).rejects.toBeInstanceOf(
      NoRunningAttemptError,
    );

    await rpc.markRunning(job.id, "worker-us-east-04");
    await rpc.markCompleted(job.id, { responseStatus: 200 });

    await expect(rpc.markFailed(job.id, "late failure")).rejects.toBeInstanceOf(NoRunningAttemptError);
  });

  test("retry before any execution returns the job unchanged", async () => {
    const { jobs, attempts, rpc } = setup();
    const job = await jobs.create(baseInput);

    expect(await rpc.retry(job.id)).toEqual(job);
    expect(await attempts.listByJob(job.id)).toEqual([]);
  });

  test("throws JobNotFoundError for an unknown job", async () => {
    const { rpc } = setup();

    await expect(rpc.markRunning("missing-job", "worker-us-east-04")).rejects.toBeInstanceOf(
      JobNotFoundError,
    );
  });

  test("keeps the legacy jobs-row behavior when the rollback flag is on for the account", async () => {
    const { jobs, attempts, rpc } = setup([baseInput.accountId]);
    const job = await jobs.create(baseInput);

    await rpc.markRunning(job.id, "worker-us-east-04");
    await rpc.markFailed(job.id, "endpoint timeout after 30s");
    await rpc.retry(job.id);
    await rpc.markRunning(job.id, "worker-us-east-07");
    const final = await rpc.markCompleted(job.id, { responseStatus: 200 });

    expect(final).toMatchObject({
      status: "completed",
      workerId: "worker-us-east-07",
      retryCount: 1,
    });
    expect(await jobs.findById(job.id)).toEqual(final);
    expect(await attempts.listByJob(job.id)).toEqual([]);
  });

  test("scopes the rollback flag per account", async () => {
    const { jobs, attempts, rpc } = setup(["acct-rolled-back"]);
    const legacyJob = await jobs.create({ ...baseInput, accountId: "acct-rolled-back" });
    const splitJob = await jobs.create(baseInput);

    await rpc.markRunning(legacyJob.id, "worker-us-east-04");
    await rpc.markRunning(splitJob.id, "worker-us-east-04");

    expect((await jobs.findById(legacyJob.id))?.status).toBe("running");
    expect(await attempts.listByJob(legacyJob.id)).toEqual([]);
    expect((await jobs.findById(splitJob.id))?.status).toBe("queued");
    expect(await attempts.listByJob(splitJob.id)).toHaveLength(1);
  });
});
