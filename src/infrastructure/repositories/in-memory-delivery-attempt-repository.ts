import { randomUUID } from "crypto";
import {
  AttemptNumberConflictError,
  DeliveryAttemptMutationError,
} from "../../domain/errors";
import type { DeliveryAttemptRepository } from "../../domain/delivery-attempt-repository";
import type {
  DeliveryAttempt,
  DeliveryAttemptStatus,
  NewDeliveryAttempt,
} from "../../domain/delivery-attempt";

const ATTEMPT_STATUSES: readonly DeliveryAttemptStatus[] = [
  "running",
  "completed",
  "failed",
  "cancelled",
];

// Mirrors sql/migrations/002: the CHECK constraints, the unique index on
// (delivery_job_id, attempt_number), and the guard_delivery_attempts_mutation
// trigger. Rows are never deleted, so no delete operation exists.
export class InMemoryDeliveryAttemptRepository implements DeliveryAttemptRepository {
  private readonly attempts = new Map<string, DeliveryAttempt>();

  async insert(input: NewDeliveryAttempt): Promise<DeliveryAttempt> {
    const attempt: DeliveryAttempt = {
      id: randomUUID(),
      deliveryJobId: input.deliveryJobId,
      attemptNumber: input.attemptNumber,
      workerId: input.workerId,
      status: input.status,
      startedAt: new Date(),
    };
    assertColumnConstraints(attempt);

    const taken = [...this.attempts.values()].some(
      (existing) =>
        existing.deliveryJobId === input.deliveryJobId &&
        existing.attemptNumber === input.attemptNumber,
    );
    if (taken) {
      throw new AttemptNumberConflictError(input.deliveryJobId, input.attemptNumber);
    }

    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  async listByJob(deliveryJobId: string): Promise<DeliveryAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.deliveryJobId === deliveryJobId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async update(next: DeliveryAttempt): Promise<DeliveryAttempt> {
    const current = this.attempts.get(next.id);
    if (!current) {
      throw new DeliveryAttemptMutationError(`delivery_attempts row ${next.id} does not exist`);
    }

    assertSingleTerminalTransition(current, next);
    assertColumnConstraints(next);

    const updated: DeliveryAttempt = { ...next };
    this.attempts.set(updated.id, updated);
    return updated;
  }
}

function assertSingleTerminalTransition(current: DeliveryAttempt, next: DeliveryAttempt): void {
  if (current.status !== "running") {
    throw new DeliveryAttemptMutationError(
      `delivery_attempts row ${current.id} is already terminal (${current.status})`,
    );
  }

  if (next.status === "running") {
    throw new DeliveryAttemptMutationError(
      `delivery_attempts row ${current.id} may only move from running to a terminal status, not ${next.status}`,
    );
  }

  const immutableChanged =
    next.deliveryJobId !== current.deliveryJobId ||
    next.attemptNumber !== current.attemptNumber ||
    next.workerId !== current.workerId ||
    next.startedAt.getTime() !== current.startedAt.getTime();
  if (immutableChanged) {
    throw new DeliveryAttemptMutationError(
      `delivery_attempts row ${current.id} terminal update may only set status, response_status, response_latency_ms, error_body, and completed_at`,
    );
  }
}

function assertColumnConstraints(attempt: DeliveryAttempt): void {
  if (!Number.isInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
    throw new DeliveryAttemptMutationError(
      `attempt_number must be an integer >= 1, got ${attempt.attemptNumber}`,
    );
  }

  if (!ATTEMPT_STATUSES.includes(attempt.status)) {
    throw new DeliveryAttemptMutationError(`invalid delivery_attempts status: ${attempt.status}`);
  }

  const { responseStatus, responseLatencyMs } = attempt;
  if (responseStatus !== undefined && (responseStatus < 100 || responseStatus > 599)) {
    throw new DeliveryAttemptMutationError(
      `response_status must be between 100 and 599, got ${responseStatus}`,
    );
  }

  if (responseLatencyMs !== undefined && responseLatencyMs < 0) {
    throw new DeliveryAttemptMutationError(
      `response_latency_ms must be >= 0, got ${responseLatencyMs}`,
    );
  }
}
