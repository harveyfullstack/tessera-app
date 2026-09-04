import { describe, expect, test } from "bun:test";
import {
  ShardQueryRouter,
  type QueryShard,
  type ShardQueryOutcome,
} from "../src/application/shard-query-router";

interface EventRow {
  eventId: string;
}

function shard(
  id: string,
  outcome: ShardQueryOutcome<EventRow>,
): QueryShard<EventRow> & { calls: string[] } {
  const calls: string[] = [];

  return {
    id,
    calls,
    async query(statement) {
      calls.push(statement);
      return outcome;
    },
  };
}

describe("ShardQueryRouter — pre-delivery characterization", () => {
  test("uses only the preferred shard when a healthy replica is available", async () => {
    const preferred = shard("clickhouse-us-east-1a", { kind: "rows", rows: [{ eventId: "evt-1" }] });
    const healthyReplica = shard("clickhouse-us-east-1b", { kind: "rows", rows: [{ eventId: "evt-replica" }] });

    const result = await new ShardQueryRouter<EventRow>().query("SELECT event_id FROM events", {
      preferred,
      replicas: [healthyReplica],
    });

    expect(result).toEqual({
      kind: "rows",
      rows: [{ eventId: "evt-1" }],
      shardId: "clickhouse-us-east-1a",
    });
    expect(preferred.calls).toEqual(["SELECT event_id FROM events"]);
    expect(healthyReplica.calls).toEqual([]); // The healthy replica is available but unused.
  });

  test("exposes a preferred-shard timeout without fallback — post-brief gap: route eligible replicas", async () => {
    const preferred = shard("clickhouse-us-east-1a", { kind: "timeout" });
    const healthyReplica = shard("clickhouse-us-east-1b", { kind: "rows", rows: [{ eventId: "evt-replica" }] });

    const result = await new ShardQueryRouter<EventRow>().query("SELECT event_id FROM events", {
      preferred,
      replicas: [healthyReplica],
    });

    expect(result).toEqual({ kind: "timeout", shardId: "clickhouse-us-east-1a" });
    expect(healthyReplica.calls).toEqual([]); // Healthy replica is available but unused until the post-brief fallback policy lands.
  });

  test("exposes a preferred-shard blank result without fallback — post-brief gap: retry healthy replicas", async () => {
    const preferred = shard("clickhouse-us-east-1a", { kind: "blank" });
    const healthyReplica = shard("clickhouse-us-east-1b", { kind: "rows", rows: [{ eventId: "evt-replica" }] });

    const result = await new ShardQueryRouter<EventRow>().query("SELECT event_id FROM events", {
      preferred,
      replicas: [healthyReplica],
    });

    expect(result).toEqual({ kind: "blank", shardId: "clickhouse-us-east-1a" });
    expect(healthyReplica.calls).toEqual([]); // Healthy replica is available but unused; blank-result fallback is intentionally absent.
  });
});
