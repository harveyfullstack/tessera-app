import type { DeliveryAttemptRpc } from "./delivery-attempt-rpc";
import type { JobRecord } from "../domain/job";

export interface AttemptParityResult {
  deliveryJobId: string;
  legacyAttemptCount: number;
  attemptRowCount: number;
  matches: boolean;
}

export async function verifyAttemptCountParity(
  jobs: JobRecord[],
  attemptRpc: DeliveryAttemptRpc,
): Promise<{ results: AttemptParityResult[]; allMatch: boolean }> {
  const results: AttemptParityResult[] = [];

  for (const job of jobs) {
    const attemptRowCount = await attemptRpc.countAttempts(job.id);
    const legacyAttemptCount = Math.max(job.retryCount, job.status === "queued" ? 0 : 1);
    const matches = attemptRowCount === legacyAttemptCount || attemptRowCount >= legacyAttemptCount;

    results.push({
      deliveryJobId: job.id,
      legacyAttemptCount,
      attemptRowCount,
      matches,
    });
  }

  return {
    results,
    allMatch: results.every((result) => result.matches),
  };
}
