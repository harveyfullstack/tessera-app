import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import {
  DELIVERY_SPLIT_PILOT_ACCOUNTS_ENV,
  DELIVERY_SPLIT_ROLLBACK_ACCOUNTS_ENV,
  DeliverySplitFlags,
} from "../src/application/delivery-split-flags";
import { JobRecordService } from "../src/application/job-record-service";
import { DeliveryAttemptConflictError, JobNotFoundError } from "../src/domain/errors";
import type { CreateJobInput, JobRecord } from "../src/domain/job";
import { InMemoryDeliveryAttemptRepository } from "../src/infrastructure/repositories/in-memory-delivery-attempt-repository";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";

const PILOT_ACCOUNT = "acct-pilot";
const OTHER_ACCOUNT = "acct-other";

const baseInput: CreateJobInput = {
  accountId: PILOT_ACCOUNT,
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

function setup(flags: DeliverySplitFlags) {
  const jobs = new InMemoryJobRepository();
  const attempts = new InMemoryDeliveryAttemptRepository();
  const rpc = new DeliveryAttemptRpc(jobs, attempts, flags);
  const service = new JobRecordService(jobs, rpc);
  return { jobs, attempts, rpc, service };
}

async function attemptsFor(
  attempts: InMemoryDeliveryAttemptRepository,
  job: JobRecord,
) {
  const intent = await attempts.findDeliveryJob(job.accountId, job.briefId, job.type);
  return intent ? attempts.listAttempts(intent.id) : [];
}

describe("DeliverySplitFlags", () => {
  test("ships with empty pilot and rollback sets", () => {
    const flags = DeliverySplitFlags.fromEnv({});

    expect(flags.isSplitEnabled(PILOT_ACCOUNT)).toBe(false);
    expect(new DeliverySplitFlags().isSplitEnabled(PILOT_ACCOUNT)).toBe(false);
  });

  test("enables only pilot accounts", () => {
    const flags = DeliverySplitFlags.fromEnv({
      [DELIVERY_SPLIT_PILOT_ACCOUNTS_ENV]: ` ${PILOT_ACCOUNT}, ,acct-pilot-2 `,
    });

    expect(flags.isSplitEnabled(PILOT_ACCOUNT)).toBe(true);
    expect(flags.isSplitEnabled("acct-pilot-2")).toBe(true);
    expect(flags.isSplitEnabled(OTHER_ACCOUNT)).toBe(false);
  });

  test("rollback flag wins over the pilot list", () => {
    const flags = DeliverySplitFlags.fromEnv({
      [DELIVERY_SPLIT_PILOT_ACCOUNTS_ENV]: PILOT_ACCOUNT,
      [DELIVERY_SPLIT_ROLLBACK_ACCOUNTS_ENV]: PILOT_ACCOUNT,
    });

    expect(flags.isSplitEnabled(PILOT_ACCOUNT)).toBe(false);
  });
});

describe("DeliveryAttemptRpc", () => {
  test("non-pilot accounts write only the legacy jobs row", async () => {
    const { attempts, service } = setup(new DeliverySplitFlags());
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    const final = await service.markCompleted(job.id, { responseStatus: 200 });

    expect(final.status).toBe("completed");
    expect(await attemptsFor(attempts, job)).toEqual([]);
  });

  test("pilot accounts append one attempt per call and keep the legacy row in sync", async () => {
    const { attempts, service } = setup(
      new DeliverySplitFlags({ pilotAccountIds: [PILOT_ACCOUNT], rollbackAccountIds: [] }),
    );
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s", { responseStatus: 504 });
    await service.retry(job.id);
    await service.markRunning(job.id, "worker-us-east-07");
    const final = await service.markCompleted(job.id, {
      workerId: "worker-us-east-07",
      responseStatus: 200,
      responseLatencyMs: 187,
    });

    expect(final.status).toBe("completed");
    expect(final.retryCount).toBe(1);

    const history = await attemptsFor(attempts, job);
    expect(history.map((row) => [row.attemptNumber, row.status])).toEqual([
      [5, "completed"],
      [4, "running"],
      [3, "queued"],
      [2, "failed"],
      [1, "running"],
    ]);
    // The earlier failure survives the next attempt instead of being overwritten.
    expect(history[3]?.errorBody).toBe("endpoint timeout after 30s");
    expect(history[3]?.responseStatus).toBe(504);
    expect(history[3]?.workerId).toBe("worker-us-east-04");
  });

  test("rolled-back pilot accounts fall back to the legacy path", async () => {
    const { attempts, service } = setup(
      new DeliverySplitFlags({
        pilotAccountIds: [PILOT_ACCOUNT],
        rollbackAccountIds: [PILOT_ACCOUNT],
      }),
    );
    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");

    expect(await attemptsFor(attempts, job)).toEqual([]);
  });

  test("racing callers receive unique, monotonically increasing attempt numbers", async () => {
    const { attempts, service } = setup(
      new DeliverySplitFlags({ pilotAccountIds: [PILOT_ACCOUNT], rollbackAccountIds: [] }),
    );
    const job = await service.ensureJobRecord(baseInput);

    await Promise.all(
      Array.from({ length: 10 }, (_, i) => service.markRunning(job.id, `worker-${i}`)),
    );

    const numbers = (await attemptsFor(attempts, job)).map((row) => row.attemptNumber);
    expect(numbers).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("attempts for the same intent share one delivery job across duplicate jobs rows", async () => {
    const { attempts, jobs, service } = setup(
      new DeliverySplitFlags({ pilotAccountIds: [PILOT_ACCOUNT], rollbackAccountIds: [] }),
    );
    const first = await jobs.create(baseInput);
    const duplicate = await jobs.create(baseInput);

    await service.markRunning(first.id, "worker-a");
    await service.markRunning(duplicate.id, "worker-b");

    const history = await attemptsFor(attempts, first);
    expect(history.map((row) => [row.attemptNumber, row.workerId])).toEqual([
      [2, "worker-b"],
      [1, "worker-a"],
    ]);
  });

  test("rejects unknown jobs before writing anything", async () => {
    const { rpc } = setup(
      new DeliverySplitFlags({ pilotAccountIds: [PILOT_ACCOUNT], rollbackAccountIds: [] }),
    );

    await expect(rpc.markRunning("missing-job", "worker-a")).rejects.toBeInstanceOf(
      JobNotFoundError,
    );
  });

  test("attempt history is append-only", async () => {
    const attempts = new InMemoryDeliveryAttemptRepository();
    const intent = await attempts.ensureDeliveryJob(baseInput);
    const row = {
      deliveryJobId: intent.id,
      attemptNumber: 1,
      status: "running" as const,
      startedAt: new Date(),
    };

    await attempts.insertAttempt(row);

    await expect(attempts.insertAttempt({ ...row, status: "failed" })).rejects.toBeInstanceOf(
      DeliveryAttemptConflictError,
    );
    expect((await attempts.listAttempts(intent.id)).map((r) => r.status)).toEqual(["running"]);
  });
});
