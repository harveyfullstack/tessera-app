import {
  countTerminalDeliveryAttempts,
  legacyTerminalAttemptCount,
} from "./delivery-execution-metrics";
import type { DeliveryAttemptRepository } from "../domain/delivery-attempt-repository";
import type { JobRecord } from "../domain/job";

export interface AttemptParityResult {
  deliveryJobId: string;
  legacyAttemptCount: number;
  attemptRowCount: number;
  matches: boolean;
}

export interface AttemptParityReport {
  results: AttemptParityResult[];
  allMatch: boolean;
  aggregateLegacyAttemptCount: number;
  aggregateAttemptRowCount: number;
  aggregateMatches: boolean;
}

export async function verifyAttemptCountParity(
  jobs: JobRecord[],
  attempts: DeliveryAttemptRepository,
): Promise<AttemptParityReport> {
  const results: AttemptParityResult[] = [];

  for (const job of jobs) {
    const rows = await attempts.listByJobId(job.id);
    const attemptRowCount = countTerminalDeliveryAttempts(rows);
    const legacyAttemptCount = legacyTerminalAttemptCount(job);

    results.push({
      deliveryJobId: job.id,
      legacyAttemptCount,
      attemptRowCount,
      matches: attemptRowCount === legacyAttemptCount,
    });
  }

  const aggregateLegacyAttemptCount = results.reduce(
    (sum, result) => sum + result.legacyAttemptCount,
    0,
  );
  const aggregateAttemptRowCount = results.reduce((sum, result) => sum + result.attemptRowCount, 0);

  return {
    results,
    allMatch: results.every((result) => result.matches),
    aggregateLegacyAttemptCount,
    aggregateAttemptRowCount,
    aggregateMatches: aggregateLegacyAttemptCount === aggregateAttemptRowCount,
  };
}
