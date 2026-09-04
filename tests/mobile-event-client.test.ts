import { describe, expect, test } from "bun:test";
import { MobileEventClient, type MobileEvent } from "../src/sdk/mobile-event-client";

describe("MobileEventClient", () => {
  test("characterizes the pre-delivery cold-start gap: configured bounded buffering retains nothing", () => {
    const delivered: MobileEvent[] = [];
    const client = new MobileEventClient((event) => delivered.push(event), 2);

    const first = client.track({ name: "app_opened" });
    const second = client.track({ name: "screen_viewed" });
    const third = client.track({ name: "purchase_started" });

    expect([first, second, third]).toEqual([
      { status: "dropped", reason: "not_initialized" },
      { status: "dropped", reason: "not_initialized" },
      { status: "dropped", reason: "not_initialized" },
    ]);
    expect(client.stats).toEqual({
      initialized: false,
      bufferCapacity: 2,
      buffered: 0,
      tracked: 3,
      delivered: 0,
      droppedBeforeInitialization: 3,
    });

    client.initialize();

    // This passing characterization is intentional: initialization cannot
    // recover the three events that were dropped during cold start.
    expect(delivered).toEqual([]);
  });

  test("delivers events tracked after initialization and keeps counters observable", () => {
    const delivered: MobileEvent[] = [];
    const client = new MobileEventClient((event) => delivered.push(event));

    client.initialize();

    expect(client.track({ name: "app_opened", properties: { source: "push" } })).toEqual({
      status: "delivered",
    });
    expect(delivered).toEqual([{ name: "app_opened", properties: { source: "push" } }]);
    expect(client.stats).toMatchObject({
      initialized: true,
      buffered: 0,
      tracked: 1,
      delivered: 1,
      droppedBeforeInitialization: 0,
    });
  });
});
