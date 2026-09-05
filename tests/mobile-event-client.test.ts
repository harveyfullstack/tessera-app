import { describe, expect, test } from "bun:test";
import { MobileEventClient, type MobileEvent } from "../src/sdk/mobile-event-client";

describe("MobileEventClient", () => {
  test("retains cold-start events up to capacity and flushes them once in order", () => {
    const delivered: MobileEvent[] = [];
    const client = new MobileEventClient((event) => delivered.push(event), 2);

    const first = client.track({ name: "app_opened" });
    const second = client.track({ name: "screen_viewed" });
    const third = client.track({ name: "purchase_started" });

    expect([first, second, third]).toEqual([
      { status: "buffered" },
      { status: "buffered" },
      { status: "dropped", reason: "buffer_full" },
    ]);
    expect(client.stats).toEqual({
      initialized: false,
      bufferCapacity: 2,
      buffered: 2,
      tracked: 3,
      delivered: 0,
      droppedBeforeInitialization: 1,
    });

    client.initialize();

    client.initialize();
    expect(delivered).toEqual([{ name: "app_opened" }, { name: "screen_viewed" }]);
    expect(client.stats.buffered).toBe(0);
    expect(client.stats.delivered).toBe(2);
  });

  test("retries an interrupted flush without replaying earlier events", () => {
    const delivered: MobileEvent[] = [];
    let fail = true;
    const client = new MobileEventClient((event) => {
      if (event.name === "screen_viewed" && fail) throw new Error("offline");
      delivered.push(event);
    });
    client.track({ name: "app_opened" });
    client.track({ name: "screen_viewed" });
    expect(() => client.initialize()).toThrow("offline");
    fail = false;
    client.initialize();
    expect(delivered).toEqual([{ name: "app_opened" }, { name: "screen_viewed" }]);
    expect(client.stats).toMatchObject({ initialized: true, buffered: 0, delivered: 2 });
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
