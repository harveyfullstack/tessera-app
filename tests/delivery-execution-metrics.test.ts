import { describe, expect, test } from "bun:test";
import {
  countTerminalDeliveryAttempts,
  legacyBackfillAttemptCount,
  legacyTerminalAttemptCount,
} from "../src/application/delivery-execution-metrics";
import type { DeliveryAttemptRecord } from "../src/domain/delivery-attempt";
import type { JobRecord } from "../src/domain/job";

const baseJob: JobRecord = {
  id: "job-1",
  accountId: "acct-1",
  briefId: "brief-1",
  type: "dispatch_webhook",
  metadata: {
    customerId: "cus",
    subscriptionId: "sub",
    endpointUrl: "https://example.com/hook",
    eventType: "test",
    payloadHash: "sha256:test",
  },
  status: "failed",
  retryCount: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("delivery execution metrics", () => {
  test("legacy backfill counts treat a fresh queued job as zero attempts", () => {
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "queued", retryCount: 0 })).toBe(0);
  });

  test("legacy backfill counts preserve prior failures plus the current queued row", () => {
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "queued", retryCount: 2 })).toBe(3);
  });

  test("legacy backfill counts include a completed recovery attempt", () => {
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "completed", retryCount: 2 })).toBe(3);
  });

  test("legacy backfill counts include the current running or cancelled row", () => {
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "running", retryCount: 2 })).toBe(3);
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "cancelled", retryCount: 1 })).toBe(2);
  });

  test("legacy backfill counts floor an immediate failure at one attempt", () => {
    expect(legacyBackfillAttemptCount({ ...baseJob, status: "failed", retryCount: 0 })).toBe(1);
  });

  test("legacy terminal counts treat a fresh queued job as zero attempts", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "queued", retryCount: 0 })).toBe(0);
  });

  test("legacy terminal counts preserve prior failures for a requeued job", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "queued", retryCount: 2 })).toBe(2);
  });

  test("legacy terminal counts include a completed recovery attempt", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "completed", retryCount: 2 })).toBe(3);
  });

  test("legacy terminal counts floor an immediate failure at one attempt", () => {
    expect(legacyTerminalAttemptCount({ ...baseJob, status: "failed", retryCount: 0 })).toBe(1);
  });

  test("terminal attempt rows exclude in-flight bookkeeping", () => {
    const attempts: DeliveryAttemptRecord[] = [
      {
        id: "1",
        deliveryJobId: "job-1",
        attemptNumber: 4,
        status: "running",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "2",
        deliveryJobId: "job-1",
        attemptNumber: 3,
        status: "queued",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "3",
        deliveryJobId: "job-1",
        attemptNumber: 2,
        status: "failed",
        errorBody: "body-2",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "4",
        deliveryJobId: "job-1",
        attemptNumber: 1,
        status: "failed",
        errorBody: "body-1",
        startedAt: new Date(),
        createdAt: new Date(),
      },
    ];

    expect(countTerminalDeliveryAttempts(attempts)).toBe(2);
  });
});
