import { describe, expect, test } from "bun:test";
import {
  AttemptNumberConflictError,
  DeliveryAttemptMutationError,
} from "../src/domain/errors";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";

const jobId = "7f000004-0000-4000-a000-00000000aaaa";

async function runningAttempt(repo: InMemoryDeliveryAttemptRepository) {
  return repo.insert({
    deliveryJobId: jobId,
    attemptNumber: 1,
    workerId: "worker-us-east-04",
    status: "running",
  });
}

describe("InMemoryDeliveryAttemptRepository", () => {
  test("rejects a duplicate (delivery_job_id, attempt_number)", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();
    await runningAttempt(repo);

    await expect(runningAttempt(repo)).rejects.toBeInstanceOf(AttemptNumberConflictError);
  });

  test("rejects attempt numbers below 1", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();

    await expect(
      repo.insert({ deliveryJobId: jobId, attemptNumber: 0, status: "running" }),
    ).rejects.toBeInstanceOf(DeliveryAttemptMutationError);
  });

  test("allows exactly one running -> terminal update", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();
    const attempt = await runningAttempt(repo);

    const failed = await repo.update({
      ...attempt,
      status: "failed",
      responseStatus: 503,
      errorBody: "endpoint returned 503",
      completedAt: new Date(),
    });
    expect(failed.status).toBe("failed");

    await expect(repo.update({ ...failed, status: "completed" })).rejects.toBeInstanceOf(
      DeliveryAttemptMutationError,
    );
    expect(await repo.listByJob(jobId)).toEqual([failed]);
  });

  test("rejects running -> running", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();
    const attempt = await runningAttempt(repo);

    await expect(
      repo.update({ ...attempt, errorBody: "still going" }),
    ).rejects.toBeInstanceOf(DeliveryAttemptMutationError);
  });

  test("rejects terminal updates that touch immutable columns", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();
    const attempt = await runningAttempt(repo);
    const terminal = { ...attempt, status: "completed" as const, completedAt: new Date() };

    await expect(repo.update({ ...terminal, workerId: "worker-other" })).rejects.toBeInstanceOf(
      DeliveryAttemptMutationError,
    );
    await expect(repo.update({ ...terminal, attemptNumber: 2 })).rejects.toBeInstanceOf(
      DeliveryAttemptMutationError,
    );
    await expect(
      repo.update({ ...terminal, startedAt: new Date(attempt.startedAt.getTime() - 1) }),
    ).rejects.toBeInstanceOf(DeliveryAttemptMutationError);
    expect((await repo.listByJob(jobId))[0]?.status).toBe("running");
  });

  test("enforces the response_status and response_latency_ms checks", async () => {
    const repo = new InMemoryDeliveryAttemptRepository();
    const attempt = await runningAttempt(repo);

    await expect(
      repo.update({ ...attempt, status: "completed", responseStatus: 99 }),
    ).rejects.toBeInstanceOf(DeliveryAttemptMutationError);
    await expect(
      repo.update({ ...attempt, status: "completed", responseLatencyMs: -1 }),
    ).rejects.toBeInstanceOf(DeliveryAttemptMutationError);
  });
});
