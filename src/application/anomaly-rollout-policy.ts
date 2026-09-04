export interface AnomalyRolloutSnapshot {
  evaluatedEvents: number;
  failedEvents: number;
  currentPercentage: number;
}

export interface AnomalyRolloutDecision {
  advance: boolean;
  nextPercentage: number;
  reason: string;
}

const MIN_EVALUATED_EVENTS = 1_000;
const MAX_FAILURE_RATE = 0.01;
const ROLLOUT_INCREMENT = 10;

export function decideAnomalyRollout(snapshot: AnomalyRolloutSnapshot): AnomalyRolloutDecision {
  const failureRate = snapshot.failedEvents / snapshot.evaluatedEvents;
  const advance = snapshot.evaluatedEvents >= MIN_EVALUATED_EVENTS && failureRate <= MAX_FAILURE_RATE;

  return {
    advance,
    nextPercentage: advance ? Math.min(snapshot.currentPercentage + ROLLOUT_INCREMENT, 100) : snapshot.currentPercentage,
    reason: advance ? "aggregate sample and failure rate are within threshold" : "aggregate rollout threshold not met",
  };
}
