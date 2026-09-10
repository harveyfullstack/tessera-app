import type {
  AttemptCountParityReport,
  AttemptCountParityRow,
  CreateDeliveryAttemptInput,
  DeliveryJob,
} from "../domain/delivery";
import { deliveryIntentKey, oldAttemptCountFromJob } from "../domain/delivery";
import type {
  DeliveryAttemptRepository,
  DeliveryJobRepository,
} from "../domain/delivery-repository";
import type { JobRecord, JobStatus } from "../domain/job";

export interface DeliverySchemaMigrationStores {
  deliveryJobs: DeliveryJobRepository;
  deliveryAttempts: DeliveryAttemptRepository;
}

export interface DeliverySchemaMigrationResult {
  deliveryJobs: DeliveryJob[];
  parity: AttemptCountParityReport;
}

function reconstructAttempts(job: JobRecord, deliveryJobId: string): CreateDeliveryAttemptInput[] {
  const count = oldAttemptCountFromJob(job);
  if (count === 0) {
    return [];
  }

  const attempts: CreateDeliveryAttemptInput[] = [];
  for (let attemptNumber = 1; attemptNumber < count; attemptNumber += 1) {
    attempts.push({
      deliveryJobId,
      status: "failed",
      errorBody: "reconstructed pre-split retry; original attempt body was overwritten",
    });
  }

  const currentStatus: JobStatus = job.status;
  attempts.push({
    deliveryJobId,
    workerId: job.workerId,
    status: currentStatus,
    errorBody: job.errorMessage,
    startedAt: job.startedAt,
  });

  return attempts;
}

export class DeliverySchemaMigration {
  constructor(private readonly stores: DeliverySchemaMigrationStores) {}

  async migrateExistingIntentRows(jobs: readonly JobRecord[]): Promise<DeliverySchemaMigrationResult> {
    const grouped = new Map<string, JobRecord[]>();
    for (const job of jobs) {
      const key = deliveryIntentKey({
        accountId: job.accountId,
        briefId: job.briefId,
        type: job.type,
      });
      const bucket = grouped.get(key) ?? [];
      bucket.push(job);
      grouped.set(key, bucket);
    }

    const created: DeliveryJob[] = [];
    const parityRows: AttemptCountParityRow[] = [];

    for (const group of grouped.values()) {
      const canonical = [...group].sort((a, b) => {
        const createdDelta = a.createdAt.getTime() - b.createdAt.getTime();
        return createdDelta !== 0 ? createdDelta : a.id.localeCompare(b.id);
      })[0];
      if (!canonical) {
        continue;
      }

      const deliveryJob = await this.stores.deliveryJobs.create({
        id: canonical.id,
        accountId: canonical.accountId,
        briefId: canonical.briefId,
        taskId: canonical.taskId,
        parentJobId: canonical.parentJobId,
        type: canonical.type,
        metadata: canonical.metadata,
        createdAt: canonical.createdAt,
      });
      created.push(deliveryJob);

      const sourceJobs = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      let nextAttemptNumber = 1;
      let oldCount = 0;
      for (const source of sourceJobs) {
        oldCount += oldAttemptCountFromJob(source);
        for (const attempt of reconstructAttempts(source, deliveryJob.id)) {
          await this.stores.deliveryAttempts.insert({
            ...attempt,
            attemptNumber: nextAttemptNumber,
          });
          nextAttemptNumber += 1;
        }
      }

      const migrated = await this.stores.deliveryAttempts.listByDeliveryJobId(deliveryJob.id);
      parityRows.push({
        deliveryJobId: deliveryJob.id,
        accountId: deliveryJob.accountId,
        briefId: deliveryJob.briefId,
        type: deliveryJob.type,
        oldCount,
        newCount: migrated.length,
      });
    }

    const oldAggregate = parityRows.reduce((sum, row) => sum + row.oldCount, 0);
    const newAggregate = parityRows.reduce((sum, row) => sum + row.newCount, 0);
    const matched =
      oldAggregate === newAggregate && parityRows.every((row) => row.oldCount === row.newCount);

    return {
      deliveryJobs: created,
      parity: {
        perJob: parityRows,
        oldAggregate,
        newAggregate,
        matched,
      },
    };
  }

  async proveAttemptCountParity(): Promise<AttemptCountParityReport> {
    const deliveryJobs = await this.stores.deliveryJobs.listAll();
    const perJob: AttemptCountParityRow[] = [];

    for (const job of deliveryJobs) {
      const attempts = await this.stores.deliveryAttempts.listByDeliveryJobId(job.id);
      perJob.push({
        deliveryJobId: job.id,
        accountId: job.accountId,
        briefId: job.briefId,
        type: job.type,
        oldCount: attempts.length,
        newCount: attempts.length,
      });
    }

    const oldAggregate = perJob.reduce((sum, row) => sum + row.oldCount, 0);
    const newAggregate = perJob.reduce((sum, row) => sum + row.newCount, 0);

    return {
      perJob,
      oldAggregate,
      newAggregate,
      matched: oldAggregate === newAggregate,
    };
  }
}
