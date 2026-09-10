import type {
  DeadLetterEntry,
  DeadLetterQueue,
  MoveToDeadLetterInput,
} from "../../domain/dead-letter-queue";

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly entries = new Map<string, DeadLetterEntry>();

  async move(input: MoveToDeadLetterInput): Promise<DeadLetterEntry> {
    const existing = this.entries.get(input.dispatchJobId);
    if (existing) {
      return existing;
    }

    const entry: DeadLetterEntry = {
      ...input,
      movedAt: new Date(),
    };
    this.entries.set(input.dispatchJobId, entry);
    return entry;
  }

  async listByBrief(briefId: string): Promise<DeadLetterEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.briefId === briefId)
      .sort((a, b) => a.movedAt.getTime() - b.movedAt.getTime());
  }
}
