import type {
  DeliveryAttemptRecord,
  DeliveryAttemptStore,
} from "../../domain/delivery-attempt";

export class InMemoryDeliveryAttemptStore implements DeliveryAttemptStore {
  private readonly attempts: DeliveryAttemptRecord[] = [];

  async insert(attempt: DeliveryAttemptRecord): Promise<void> {
    this.attempts.push(attempt);
  }

  async updateLatest(
    jobId: string,
    update: Pick<DeliveryAttemptRecord, "status" | "errorMessage" | "details" | "completedAt">,
  ): Promise<DeliveryAttemptRecord | null> {
    const index = this.attempts
      .map((attempt, position) => ({ attempt, position }))
      .filter(({ attempt }) => attempt.deliveryJobId === jobId)
      .sort((a, b) => b.attempt.attemptNumber - a.attempt.attemptNumber)[0]?.position;
    if (index === undefined) {
      return null;
    }
    const current = this.attempts[index];
    if (!current) {
      return null;
    }
    const updated = { ...current, ...update };
    this.attempts[index] = updated;
    return updated;
  }

  async listByJob(jobId: string): Promise<DeliveryAttemptRecord[]> {
    return this.attempts
      .filter((attempt) => attempt.deliveryJobId === jobId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }
}
