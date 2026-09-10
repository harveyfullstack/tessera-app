export interface DlqBoundEndpoint {
  deliveryJobId: string;
  accountId: string;
  briefId: string;
  endpointUrl: string;
  attemptCount: number;
  lastAttemptBodies: string[];
}

export interface DeadLetterQueue {
  bind(entry: DlqBoundEndpoint): void;
  listByBrief(briefId: string): DlqBoundEndpoint[];
  isBound(deliveryJobId: string): boolean;
}

export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  private readonly entries = new Map<string, DlqBoundEndpoint>();

  bind(entry: DlqBoundEndpoint): void {
    this.entries.set(entry.deliveryJobId, entry);
  }

  listByBrief(briefId: string): DlqBoundEndpoint[] {
    return [...this.entries.values()].filter((entry) => entry.briefId === briefId);
  }

  isBound(deliveryJobId: string): boolean {
    return this.entries.has(deliveryJobId);
  }
}
