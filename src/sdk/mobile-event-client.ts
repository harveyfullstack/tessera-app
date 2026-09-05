export type MobileEvent = {
  name: string;
  properties?: Record<string, unknown>;
};

export type TrackResult =
  | { status: "delivered" }
  | { status: "dropped"; reason: "not_initialized" };

export type MobileEventClientStats = {
  initialized: boolean;
  bufferCapacity: number;
  buffered: number;
  tracked: number;
  delivered: number;
  droppedBeforeInitialization: number;
};

export class MobileEventClient {
  private initialized = false;
  private tracked = 0;
  private delivered = 0;
  private droppedBeforeInitialization = 0;

  constructor(
    private readonly deliver: (event: MobileEvent) => void,
    private readonly bufferCapacity = 100,
  ) {}

  initialize(): void {
    this.initialized = true;
  }

  track(event: MobileEvent): TrackResult {
    this.tracked += 1;

    if (!this.initialized) {
      this.droppedBeforeInitialization += 1;
      return { status: "dropped", reason: "not_initialized" };
    }

    this.deliver(event);
    this.delivered += 1;
    return { status: "delivered" };
  }

  get stats(): MobileEventClientStats {
    return {
      initialized: this.initialized,
      bufferCapacity: this.bufferCapacity,
      buffered: 0,
      tracked: this.tracked,
      delivered: this.delivered,
      droppedBeforeInitialization: this.droppedBeforeInitialization,
    };
  }
}
