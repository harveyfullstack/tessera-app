import { describe, expect, test } from "bun:test";
import { DeliveryAttemptRpc } from "../src/application/delivery-attempt-rpc";
import { JobRecordService } from "../src/application/job-record-service";
import { InMemoryJobRepository } from "../src/infrastructure/repositories/in-memory-job-repository";
import { DeliveryRollbackUnavailableError } from "../src/domain/errors";
import type { JobRepository } from "../src/domain/job-repository";
import type { CreateJobInput, JobRecord, JobType } from "../src/domain/job";

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

describe("JobRecordService", () => {
  test("reuses canonical job when one already exists", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const first = await service.ensureJobRecord(baseInput);
    const second = await service.ensureJobRecord(baseInput);

    expect(second.id).toBe(first.id);
  });

  test("records each RPC operation with an operation-specific status", async () => {
    const repo = new InMemoryJobRepository();
    const service = new JobRecordService(repo);

    const job = await service.ensureJobRecord(baseInput);

    await service.markRunning(job.id, "worker-us-east-04");
    await service.markFailed(job.id, "endpoint timeout after 30s");
    await service.retry(job.id);
    const final = await service.markRunning(job.id, "worker-us-east-07");

    expect(final.retryCount).toBe(1);
    expect(final.workerId).toBe("worker-us-east-07");
    expect(final.errorMessage).toBeUndefined();
    expect(await repo.listAttempts(job.id)).toMatchObject([
      { attemptNumber: 1, status: "running" },
      { attemptNumber: 2, status: "failed" },
      { attemptNumber: 3, status: "retry" },
      { attemptNumber: 4, status: "running" },
    ]);
  });

  test("assigns attempt numbers monotonically when terminal writes race", async () => {
    const repo = new InMemoryJobRepository();
    const firstService = new JobRecordService(repo, new DeliveryAttemptRpc(repo));
    const secondService = new JobRecordService(repo, new DeliveryAttemptRpc(repo));
    const job = await firstService.ensureJobRecord(baseInput);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? firstService : secondService).markFailed(
          job.id,
          `failure-${index}`,
        ),
      ),
    );

    expect((await repo.listAttempts(job.id)).map((attempt) => attempt.attemptNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  test("fails closed when rollback is enabled without a legacy repository", async () => {
    const repo = new InMemoryJobRepository();
    const checkedAccounts: string[] = [];
    const rpc = new DeliveryAttemptRpc(repo, (accountId) => {
      checkedAccounts.push(accountId);
      return accountId === "acct-1";
    });
    const service = new JobRecordService(repo, rpc);
    const job = await service.ensureJobRecord(baseInput);

    await expect(service.markRunning(job.id, "worker-us-east-04")).rejects.toBeInstanceOf(
      DeliveryRollbackUnavailableError,
    );

    expect(checkedAccounts).toEqual(["acct-1"]);
    expect(await repo.listAttempts(job.id)).toEqual([]);
  });

  test("can produce duplicate intent rows under race conditions", async () => {
    const repo = new RacyJobRepository();
    const service = new JobRecordService(repo);

    const [a, b] = await Promise.all([
      service.ensureJobRecord(baseInput),
      service.ensureJobRecord(baseInput),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(repo.created.length).toBe(2);
  });
});

class RacyJobRepository extends InMemoryJobRepository implements JobRepository {
  created: JobRecord[] = [];

  async findByBriefAndType(_briefId: string, _type: JobType): Promise<JobRecord[]> {
    // Stale read window where concurrent callers both observe no row.
    return [];
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const record = await super.create(input);
    this.created.push(record);
    return record;
  }
}
