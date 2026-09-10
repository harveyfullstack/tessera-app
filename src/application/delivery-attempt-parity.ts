import { countTerminalDeliveryAttempts, legacyTerminalAttemptCount } from "./delivery-execution-metrics";
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
  resolveJob: (jobId: string) => Promise<JobRecord | null> = async () => null,
): Promise<{ results: AttemptParityResult[]; allMatch: boolean }> {
  const results: AttemptParityResult[] = [];

  for (const job of jobs) {
    const current = (await resolveJob(job.id)) ?? job;
    const attempts = await attemptRpc.listAttempts(current.id);
    const attemptRowCount = countTerminalDeliveryAttempts(attempts);
    const legacyAttemptCount = legacyTerminalAttemptCount(current);
    const matches = attemptRowCount === legacyAttemptCount;

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
