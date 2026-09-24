import type { DeadLetterEntry, DeadLetterQueue } from "../../domain/dead-letter-queue";

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly entries = new Map<string, DeadLetterEntry>();

  async enqueue(entry: DeadLetterEntry): Promise<boolean> {
    if (this.entries.has(entry.deliveryJobId)) {
      return false;
    }

    this.entries.set(entry.deliveryJobId, entry);
    return true;
  }

  async listByBrief(briefId: string): Promise<DeadLetterEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.briefId === briefId)
      .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
  }
}
