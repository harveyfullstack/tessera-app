import { backfillAttemptStatuses } from "./delivery-execution-metrics";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRecord } from "../domain/job";

export async function backfillDeliveryAttempts(
  job: JobRecord,
  attempts: DeliveryAttemptRepository,
): Promise<void> {
  const statuses = backfillAttemptStatuses(job);

  for (const [index, status] of statuses.entries()) {
    const attemptNumber = index + 1;
    const isLatest = attemptNumber === statuses.length;
    await attempts.insert({
      deliveryJobId: job.id,
      attemptNumber,
      workerId: isLatest ? job.workerId : undefined,
      status,
      errorBody: isLatest ? job.errorMessage : "legacy failed execution",
      startedAt: job.startedAt ?? job.updatedAt,
      completedAt: isLatest ? job.completedAt : undefined,
    });
  }
}
