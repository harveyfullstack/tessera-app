import { describe, expect, test } from "bun:test";
import { decideAnomalyRollout } from "../src/application/anomaly-rollout-policy";

describe("decideAnomalyRollout — pre-delivery characterization", () => {
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
    // Post-brief gap: require per-segment samples and error-rate guardrails before advancing.
  });

  test("unsafely advances immediately after the aggregate threshold is reached", () => {
    const decision = decideAnomalyRollout({
      evaluatedEvents: 1_000,
      failedEvents: 0,
      currentPercentage: 90,
    });

    expect(decision.nextPercentage).toBe(100);
    // Post-brief gap: require a minimum observation window, not only a sample count.
  });

  test("holds when the aggregate failure rate exceeds the current threshold", () => {
    expect(decideAnomalyRollout({
      evaluatedEvents: 1_000,
      failedEvents: 11,
      currentPercentage: 20,
    }).advance).toBeFalse();
  });
});
