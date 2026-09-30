import { describe, expect, test } from "bun:test";
import { decideAnomalyRollout } from "../src/application/anomaly-rollout-policy";

describe("decideAnomalyRollout", () => {
  test("unsafely advances on an acceptable aggregate despite an unrepresented segment", () => {
    const decision = decideAnomalyRollout({
      evaluatedEvents: 1_000,
      failedEvents: 10,
      currentPercentage: 20,
    });

    expect(decision).toEqual({
      advance: true,
      nextPercentage: 30,
      reason: "aggregate sample and failure rate are within threshold",
    });
    // Advances on aggregate samples and failure rate without per-segment guardrails.
  });

  test("unsafely advances immediately after the aggregate threshold is reached", () => {
    const decision = decideAnomalyRollout({
      evaluatedEvents: 1_000,
      failedEvents: 0,
      currentPercentage: 90,
    });

    expect(decision.nextPercentage).toBe(100);
    // No minimum observation window is required once the aggregate thresholds are met.
  });

  test("holds when the aggregate failure rate exceeds the current threshold", () => {
    expect(decideAnomalyRollout({
      evaluatedEvents: 1_000,
      failedEvents: 11,
      currentPercentage: 20,
    }).advance).toBeFalse();
  });
});
