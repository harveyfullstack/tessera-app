export type MobileEvent = {
  name: string;
  properties?: Record<string, unknown>;
};

export type TrackResult =
  | { status: "delivered" }
  | { status: "buffered" }
  | { status: "dropped"; reason: "buffer_full" };

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
  private readonly buffer: Array<MobileEvent | undefined>;
  private head = 0;
  private buffered = 0;
  private initializing = false;

  constructor(
    private readonly deliver: (event: MobileEvent) => void,
    private readonly bufferCapacity = 4,
  ) {
    this.buffer = new Array(bufferCapacity);
  }

  initialize(): void {
    if (this.initialized || this.initializing) return;
    this.initializing = true;
    try {
      while (this.buffered > 0) {
        const event = this.buffer[this.head]!;
        this.deliver(event);
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.bufferCapacity;
        this.buffered -= 1;
        this.delivered += 1;
      }
      this.initialized = true;
    } finally {
      this.initializing = false;
    }
  }

  track(event: MobileEvent): TrackResult {
    this.tracked += 1;

    if (!this.initialized) {
      if (this.buffered === this.bufferCapacity) {
        this.droppedBeforeInitialization += 1;
        return { status: "dropped", reason: "buffer_full" };
      }
      this.buffer[(this.head + this.buffered) % this.bufferCapacity] = event;
      this.buffered += 1;
      return { status: "buffered" };
    }

    this.deliver(event);
    this.delivered += 1;
    return { status: "delivered" };
  }

  get stats(): MobileEventClientStats {
    return {
      initialized: this.initialized,
      bufferCapacity: this.bufferCapacity,
      buffered: this.buffered,
      tracked: this.tracked,
      delivered: this.delivered,
      droppedBeforeInitialization: this.droppedBeforeInitialization,
    };
  }
}
